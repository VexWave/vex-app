import { playerController } from "@/hooks/usePlayer";
import { CacheBuster } from "@/lib/cacheBuster";
import type { Track } from "@/player/types";
import type {
	CreatePlaylistParams,
	EditPlaylistParams,
	RemotePlaylist,
} from "../../shared/rpcSchema";
import { submitIdList } from "./idListEdit";
import { libraryService, trackIdForServerId } from "./LibraryService";
import type { MutationResult } from "./LibraryService";
import { bun } from "./rpc";
import { sessionService } from "./SessionService";

/** Queue context id for "the queue is this playlist" (see PlayerController). */
export function playlistQueueContext(playlistId: number): string {
	return `playlist-${playlistId}`;
}

/** Immutable snapshot of the server playlist list, consumed by React. */
export interface PlaylistsState {
	playlists: RemotePlaylist[];
	loading: boolean;
	/** List-level error (fetch or delete failures). */
	error: string | null;
}

/**
 * Owns the server playlists: fetches them when a session starts and clears
 * them when it ends. Mutations refetch instead of patching locally — the
 * server assigns ids and drops deleted tracks, so it stays the single source
 * of truth. Reordering is the one exception, and holds a local order until the
 * server confirms it (`applyOrder`). Track membership is edited by full
 * replacement of the ordered `trackIds` (that's the whole contract;
 * add/remove/reorder are conveniences over it).
 */
export class PlaylistService {
	private subscribers = new Set<() => void>();
	private snapshot: PlaylistsState = {
		playlists: [],
		loading: false,
		error: null,
	};
	private fetchSeq = 0;
	// The StreamProxy cover URL for a playlist never changes and forwards no
	// cache headers, so after a cover is replaced we bust it (keyed by playlist
	// id) to force Chromium to re-fetch. See CacheBuster.
	private imageCache = new CacheBuster();
	// Locally held track order for playlists with a reorder in flight, keyed by
	// playlist id (see applyOrder). Keyed rather than a single value because a
	// reorder outlives the view it was made in — dragging in one playlist and
	// navigating to another before the request lands must not cross the two.
	private pendingOrders = new Map<number, string[]>();

	constructor() {
		let previousStatus = sessionService.getSnapshot().status;
		sessionService.subscribe(() => {
			const status = sessionService.getSnapshot().status;
			if (status === previousStatus) return;
			previousStatus = status;
			if (status === "loggedIn") {
				void this.refresh();
			} else if (status === "loggedOut") {
				this.fetchSeq += 1; // drop in-flight results from the old session
				this.imageCache.clear();
				this.pendingOrders.clear();
				this.update({ playlists: [], loading: false, error: null });
			}
		});

		// A deleted track is dropped from every playlist server-side, which
		// leaves this list holding an id the server no longer knows — and a
		// membership edit replaces `trackIds` wholesale, where an unknown id is
		// a 400. `submitIdList` recovers from that, but a deletion is the one
		// moment the client can see it coming, so refetch the lists that
		// carried the track and let the next edit find them current. Only ids
		// the library *had* and lost count as deletions: one it doesn't know
		// yet (its refresh trailing a playlist's) is a track very much alive.
		let knownTrackIds = libraryTrackIds();
		libraryService.subscribe(() => {
			const trackIds = libraryTrackIds();
			const deleted = new Set(
				[...knownTrackIds].filter((id) => !trackIds.has(id)),
			);
			knownTrackIds = trackIds;
			// Logging out empties the library too; that is the subscription
			// above's business, and refetching would be unauthorized anyway.
			if (sessionService.getSnapshot().status !== "loggedIn") return;
			if (deleted.size > 0 && this.holdsAny(deleted)) void this.refresh();
		});
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): PlaylistsState => this.snapshot;

	/**
	 * A playlist's ordered playable tracks, joined against the library.
	 * Ids the library doesn't know (e.g. a track deleted moments ago, before
	 * the next playlists refetch) are skipped — the server guarantees they're
	 * gone from the playlist too.
	 */
	tracksOf(playlist: RemotePlaylist): Track[] {
		const byId = new Map(
			libraryService.getSnapshot().tracks.map((track) => [track.id, track]),
		);
		const tracks: Track[] = [];
		for (const serverId of playlist.trackIds) {
			const track = byId.get(trackIdForServerId(serverId));
			if (track) tracks.push(track);
		}
		return tracks;
	}

	/**
	 * Make the playlist the play queue and start at `index` (of its joined
	 * track list). Later membership edits keep the queue in sync via refresh.
	 */
	play(playlist: RemotePlaylist, index = 0): void {
		playerController.playCollection(
			playlistQueueContext(playlist.id),
			this.tracksOf(playlist),
			index,
		);
	}

	/** Play the playlist, or toggle playback when it already owns the queue. */
	playOrToggle(playlist: RemotePlaylist): void {
		playerController.playOrToggleCollection(
			playlistQueueContext(playlist.id),
			this.tracksOf(playlist),
		);
	}

	/** Re-fetch the playlist list from the server. */
	async refresh(): Promise<void> {
		const seq = ++this.fetchSeq;
		this.update({ loading: true, error: null });
		let result;
		try {
			result = await bun.listPlaylists();
		} catch (err) {
			// RPC transport failure or timeout (e.g. bun process unreachable).
			if (seq !== this.fetchSeq) return;
			this.update({
				loading: false,
				error:
					err instanceof Error ? err.message : "Failed to load playlists",
			});
			return;
		}
		if (seq !== this.fetchSeq) return;
		if (!result.ok) {
			if (result.status === 401) {
				sessionService.markExpired("Session expired — please log in again.");
			}
			this.update({ loading: false, error: result.error });
			return;
		}
		// Bust replaced covers: their imageUrl is stable, so map the fresh list
		// through the cache-buster before it reaches the UI. trackIds are
		// deduped defensively — playlists predating the no-duplicates rule may
		// still carry copies; the next membership edit persists the deduped list.
		const playlists = result.playlists.map((playlist) => ({
			...playlist,
			trackIds: this.orderOf(playlist.id, [...new Set(playlist.trackIds)]),
			imageUrl: this.imageCache.apply(String(playlist.id), playlist.imageUrl),
		}));
		this.update({ playlists, loading: false, error: null });
		this.syncQueue();
	}

	/**
	 * The order a freshly fetched playlist should be shown in: the server's,
	 * unless a reorder for it is still on its way, in which case the local one
	 * wins. Every reorder triggers a refetch, so without this the list would
	 * snap back to the pre-drag order for as long as a *later* reorder is still
	 * in flight. Membership the local order doesn't know about is the server's
	 * to decide — ids it dropped go, ids it gained land at the end.
	 */
	private orderOf(playlistId: number, serverTrackIds: string[]): string[] {
		const pending = this.pendingOrders.get(playlistId);
		if (!pending) return serverTrackIds;
		const remaining = new Set(serverTrackIds);
		const trackIds = pending.filter((id) => remaining.delete(id));
		return [...trackIds, ...serverTrackIds.filter((id) => remaining.has(id))];
	}

	/**
	 * Persist a new track order, showing it immediately. The reorder is applied
	 * to the snapshot up front — a dragged row that springs back to its old
	 * slot for the round trip reads as a failed drag — and only then sent, so
	 * what a second reorder computes from already carries the first one's move.
	 * A rejected edit drops the local order and refetches the server's.
	 */
	private applyOrder(playlistId: number, trackIds: string[]): void {
		this.pendingOrders.set(playlistId, trackIds);
		this.update({
			playlists: this.snapshot.playlists.map((playlist) =>
				playlist.id === playlistId ? { ...playlist, trackIds } : playlist,
			),
		});
		this.syncQueue();

		void this.enqueue(async () => {
			const result = await this.edit({ id: playlistId, trackIds });
			// Each reorder submits a fresh array, so finding this one still in
			// the map is what identifies it as the last still out there — only
			// that one may retire the local order, since an earlier one landing
			// has to leave its successor's order standing.
			const isLast = this.pendingOrders.get(playlistId) === trackIds;
			if (isLast) this.pendingOrders.delete(playlistId);
			if (!result.ok) {
				this.update({ error: result.error });
				// Rows sit in an order the server rejected. The refetch is what
				// puts the list back to what actually persisted — unless a later
				// reorder is still queued, which brings its own refetch.
				if (isLast) await this.refresh();
			}
		});
	}

	/**
	 * If a playlist currently owns the play queue, mirror its fresh content
	 * into it — so adding/removing/reordering tracks while it plays takes
	 * effect. A playlist that was deleted leaves the queue playing its last
	 * known content (its context id just goes stale, which is harmless).
	 */
	private syncQueue(): void {
		const context = playerController.queueContextId;
		if (context === null) return;
		const playlist = this.snapshot.playlists.find(
			(candidate) => playlistQueueContext(candidate.id) === context,
		);
		if (!playlist) return;
		playerController.syncCollection(context, this.tracksOf(playlist));
	}

	/**
	 * Create a playlist on the server, then refetch. The refetch is awaited so
	 * the new playlist is in the snapshot by the time this resolves. Returns
	 * the outcome instead of writing `error` to the snapshot so the dialog can
	 * show the failure inline and stay open.
	 */
	async create(input: CreatePlaylistParams): Promise<MutationResult> {
		let result;
		try {
			result = await bun.createPlaylist(input);
		} catch (err) {
			return {
				ok: false,
				error:
					err instanceof Error ? err.message : "Creating the playlist failed",
			};
		}
		if (!result.ok) {
			if (result.status === 401) {
				sessionService.markExpired("Session expired — please log in again.");
			}
			return { ok: false, error: result.error };
		}
		await this.refresh();
		return { ok: true };
	}

	/**
	 * Edit a playlist on the server (name/cover/track list), then
	 * refetch. Like `create`, returns the outcome so dialogs can show a
	 * failure inline and stay open.
	 */
	async edit(input: EditPlaylistParams): Promise<MutationResult> {
		let result;
		try {
			result = await bun.editPlaylist(input);
		} catch (err) {
			return {
				ok: false,
				error:
					err instanceof Error ? err.message : "Editing the playlist failed",
			};
		}
		if (!result.ok) {
			if (result.status === 401) {
				sessionService.markExpired("Session expired — please log in again.");
			}
			return { ok: false, error: result.error };
		}
		// The cover URL is stable, so bust it when the image changed (new bytes
		// or removal) before the refresh maps it onto the list.
		if (input.imageBase64 !== undefined) this.imageCache.bump(String(input.id));
		await this.refresh();
		return { ok: true };
	}

	// Membership edits send a full replacement of trackIds, so two in flight at
	// once would clobber each other. Running them one after another gives each
	// the list its predecessor left behind.
	private membershipChain: Promise<unknown> = Promise.resolve();

	/**
	 * Queue a membership edit behind the ones already running. Steps never
	 * reject (edit() returns failures), but the tail swallows rejections anyway
	 * so one bug can't wedge the chain forever.
	 */
	private enqueue<T>(step: () => Promise<T>): Promise<T> {
		const run = this.membershipChain.then(step);
		this.membershipChain = run.catch(() => undefined);
		return run;
	}

	/**
	 * Queue an edit that computes its new track list when its turn comes, from
	 * whatever the preceding edit's refetch produced — so quick successive adds
	 * from the picker don't each drop the one before. Nothing is shown until
	 * the round trip lands; reordering is the exception, see `applyOrder`.
	 *
	 * `submitIdList` runs the same computation again against refetched state if
	 * the server rejects the list, which is what makes a membership edit survive
	 * a track that died under it.
	 */
	private chainMembershipEdit(
		playlistId: number,
		buildTrackIds: (current: readonly string[]) => string[] | null,
	): Promise<MutationResult> {
		return this.enqueue(async (): Promise<MutationResult> => {
			const result = await submitIdList({
				build: () => {
					// A playlist this list doesn't hold is either gone from the
					// server or not fetched yet — the refetch is what tells them
					// apart, so leave that call to submitIdList.
					const playlist = this.byId(playlistId);
					if (!playlist) return "stale";
					return buildTrackIds(playlist.trackIds) ?? "noop";
				},
				send: (trackIds) => this.edit({ id: playlistId, trackIds }),
				resync: () => this.refresh(),
				staleError: "Playlist not found.",
			});
			// Row menus and the add picker fire-and-forget these, so a failure
			// also lands in the snapshot's error banner.
			if (!result.ok) this.update({ error: result.error });
			return result;
		});
	}

	/**
	 * Add tracks to the top of a playlist — newest additions first, so what
	 * the user just added is immediately visible without scrolling. A track
	 * can be in a playlist at most once (the server rejects duplicates), so
	 * ids already present are skipped; when nothing is left to add the edit
	 * is a no-op.
	 */
	addTracks(
		playlistId: number,
		serverTrackIds: string[],
	): Promise<MutationResult> {
		return this.chainMembershipEdit(playlistId, (current) => {
			const additions = [...new Set(serverTrackIds)].filter(
				(id) => !current.includes(id),
			);
			if (additions.length === 0) return null;
			return [...additions, ...current];
		});
	}

	/** Remove tracks from a playlist (ids it doesn't contain are ignored). */
	removeTracks(
		playlistId: number,
		serverTrackIds: string[],
	): Promise<MutationResult> {
		return this.chainMembershipEdit(playlistId, (current) => {
			const trackIds = current.filter((id) => !serverTrackIds.includes(id));
			return trackIds.length === current.length ? null : trackIds;
		});
	}

	/** Swap a track with its neighbour above/below. */
	moveTrack(
		playlistId: number,
		serverTrackId: string,
		direction: -1 | 1,
	): void {
		const current = this.byId(playlistId)?.trackIds;
		if (!current) return;
		const from = current.indexOf(serverTrackId);
		if (from === -1) return;
		const to = from + direction;
		if (to < 0 || to >= current.length) return;
		const trackIds = [...current];
		[trackIds[from], trackIds[to]] = [trackIds[to], trackIds[from]];
		this.applyOrder(playlistId, trackIds);
	}

	/**
	 * Move a track into the slot another one holds — what dropping a dragged
	 * row onto `targetServerTrackId` means. Both ends are named by server id
	 * rather than list position: the row a drag started from is looked up again
	 * at drop time, and the joined list the UI drags in skips ids the library
	 * doesn't know yet, so its indices aren't the stored list's.
	 */
	reorderTrack(
		playlistId: number,
		serverTrackId: string,
		targetServerTrackId: string,
	): void {
		const current = this.byId(playlistId)?.trackIds;
		if (!current) return;
		const from = current.indexOf(serverTrackId);
		const to = current.indexOf(targetServerTrackId);
		if (from === -1 || to === -1 || from === to) return;
		const trackIds = [...current];
		trackIds.splice(to, 0, ...trackIds.splice(from, 1));
		this.applyOrder(playlistId, trackIds);
	}

	/**
	 * Delete a playlist on the server, then refetch. Failures land in the
	 * snapshot's `error` — the confirm dialog closes before the result
	 * arrives, so the list banner is where the user still is.
	 */
	async remove(id: number): Promise<void> {
		let result;
		try {
			result = await bun.deletePlaylist({ id });
		} catch (err) {
			this.update({
				error:
					err instanceof Error ? err.message : "Deleting the playlist failed",
			});
			return;
		}
		if (!result.ok) {
			if (result.status === 401) {
				sessionService.markExpired("Session expired — please log in again.");
			}
			this.update({ error: result.error });
			return;
		}
		void this.refresh();
	}

	private byId(playlistId: number): RemotePlaylist | undefined {
		return this.snapshot.playlists.find(
			(playlist) => playlist.id === playlistId,
		);
	}

	/** Whether any playlist references one of these (library-side) track ids. */
	private holdsAny(trackIds: ReadonlySet<string>): boolean {
		return this.snapshot.playlists.some((playlist) =>
			playlist.trackIds.some((serverId) =>
				trackIds.has(trackIdForServerId(serverId)),
			),
		);
	}

	private update(patch: Partial<PlaylistsState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** The library's track ids, for spotting the ones a refresh dropped. */
function libraryTrackIds(): Set<string> {
	return new Set(libraryService.getSnapshot().tracks.map((track) => track.id));
}

/** App-wide singleton — playlist state must survive component unmounts. */
export const playlistService = new PlaylistService();
