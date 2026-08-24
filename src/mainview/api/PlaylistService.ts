import { playerController } from "@/hooks/usePlayer";
import type { Track } from "@/player/types";
import { MAX_TRACKS_PER_PLAYLIST } from "../../shared/limits";
import type {
	CreatePlaylistParams,
	EditPlaylistParams,
	RemotePlaylist,
} from "../../shared/rpcSchema";
import { submitIdList } from "./idListEdit";
import { libraryData } from "./LibraryData";
import { libraryService } from "./LibraryService";
import { mutate } from "./mutate";
import type { MutationResult } from "./mutate";
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
	/** List-level error (the read's, or a mutation that failed). */
	error: string | null;
}

/**
 * The server's playlists, deduped and with a reorder still in flight showing
 * over them. Mutations write and then re-read `libraryData` rather than
 * patching locally — the server assigns ids and drops deleted tracks, so it
 * stays the single source of truth. Reordering is the one exception, and holds
 * a local order until the server confirms it (`applyOrder`). Track membership
 * is edited by full replacement of the ordered `trackIds` (that's the whole
 * contract; add/remove/reorder are conveniences over it).
 */
export class PlaylistService {
	private subscribers = new Set<() => void>();
	private snapshot: PlaylistsState = {
		playlists: [],
		loading: false,
		error: null,
	};
	// Locally held track order for playlists with a reorder in flight, keyed by
	// playlist id (see applyOrder). Keyed rather than a single value because a
	// reorder outlives the view it was made in — dragging in one playlist and
	// navigating to another before the request lands must not cross the two.
	private pendingOrders = new Map<number, string[]>();
	// The last mutation's failure, until the next read clears it.
	private mutationError: string | null = null;
	// The payload the list above was built from; see LibraryService.
	private builtFrom: RemotePlaylist[] = libraryData.getSnapshot().playlists;

	constructor() {
		libraryData.subscribe(() => this.apply());

		// A pending order outlives the request that carries it, so one still
		// held at logout would be overlaid onto whatever playlist takes that id
		// in the next session — an order the server never had, and one no read
		// can dislodge until another reorder retires it.
		let previousStatus = sessionService.getSnapshot().status;
		sessionService.subscribe(() => {
			const status = sessionService.getSnapshot().status;
			if (status === previousStatus) return;
			previousStatus = status;
			if (status === "loggedOut") this.pendingOrders.clear();
		});
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): PlaylistsState => this.snapshot;

	/** A playlist's ordered playable tracks, joined against the library. */
	tracksOf(playlist: RemotePlaylist): Track[] {
		return libraryService.tracksByIds(playlist.trackIds);
	}

	/**
	 * Make the playlist the play queue and start at `index` (of its joined
	 * track list). Later membership edits keep the queue in sync via `apply`.
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

	/** Rebuild the list from the library payload, then republish. */
	private apply(): void {
		const data = libraryData.getSnapshot();
		if (data.loading) this.mutationError = null;
		const error = this.mutationError ?? data.error;
		if (data.playlists === this.builtFrom) {
			this.update({ loading: data.loading, error });
			return;
		}
		this.builtFrom = data.playlists;
		// trackIds are deduped defensively — playlists predating the
		// no-duplicates rule may still carry copies; the next membership edit
		// persists the deduped list.
		const playlists = data.playlists.map((playlist) => ({
			...playlist,
			trackIds: this.orderOf(playlist.id, [...new Set(playlist.trackIds)]),
		}));
		this.update({ playlists, loading: data.loading, error });
		this.syncQueue();
	}

	/**
	 * The order a freshly read playlist should be shown in: the server's, unless
	 * a reorder for it is still on its way, in which case the local one wins.
	 * Every reorder triggers a re-read, so without this the list would snap back
	 * to the pre-drag order for as long as a *later* reorder is still in flight.
	 * Membership the local order doesn't know about is the server's to decide —
	 * ids it dropped go, ids it gained land at the end.
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
	 * A rejected edit drops the local order and re-reads the server's.
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
				this.fail(result.error);
				// Rows sit in an order the server rejected. The re-read is what
				// puts the list back to what actually persisted — unless a later
				// reorder is still queued, which brings its own.
				if (isLast) await libraryData.refresh();
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
	 * Create a playlist on the server, then re-read. The read is awaited so the
	 * new playlist is in the snapshot by the time this resolves. Returns the
	 * outcome instead of writing `error` to the snapshot so the dialog can show
	 * the failure inline and stay open.
	 */
	async create(input: CreatePlaylistParams): Promise<MutationResult> {
		const result = await mutate(
			() => bun.createPlaylist(input),
			"Creating the playlist failed",
		);
		if (result.ok) await libraryData.refresh();
		return result;
	}

	/**
	 * Edit a playlist on the server (name/cover/track list), then re-read. Like
	 * `create`, returns the outcome so dialogs can show a failure inline and
	 * stay open.
	 */
	async edit(input: EditPlaylistParams): Promise<MutationResult> {
		const result = await mutate(
			() => bun.editPlaylist(input),
			"Editing the playlist failed",
		);
		if (result.ok) await libraryData.refresh();
		return result;
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
	 * whatever the preceding edit's re-read produced — so quick successive adds
	 * from the picker don't each drop the one before. Nothing is shown until
	 * the round trip lands; reordering is the exception, see `applyOrder`.
	 *
	 * `submitIdList` runs the same computation again against re-read state if
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
					// server or not read yet — the re-read is what tells them
					// apart, so leave that call to submitIdList.
					const playlist = this.byId(playlistId);
					if (!playlist) return "stale";
					return buildTrackIds(playlist.trackIds) ?? "noop";
				},
				send: (trackIds) => this.edit({ id: playlistId, trackIds }),
				staleError: "Playlist not found.",
			});
			// Row menus and the add picker fire-and-forget these, so a failure
			// also lands in the snapshot's error banner.
			if (!result.ok) this.fail(result.error);
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
		// Read against the list this service mirrors, which an edit still in the
		// chain can leave a few ids short of the server's — deliberately, because
		// the server enforces the real ceiling either way. All this buys is a
		// message that names the limit instead of a rejected list.
		const held = this.byId(playlistId)?.trackIds ?? [];
		// Only ids the playlist doesn't already hold make it grow — re-adding a
		// track it has is a no-op the builder below drops, and counting those
		// would refuse an add that costs the playlist nothing.
		const growth = [...new Set(serverTrackIds)].filter(
			(id) => !held.includes(id),
		).length;
		if (held.length + growth > MAX_TRACKS_PER_PLAYLIST) {
			const error = `A playlist holds at most ${MAX_TRACKS_PER_PLAYLIST} tracks.`;
			// Row menus and the picker fire-and-forget, so it also has to land in
			// the banner — same reason chainMembershipEdit puts failures there.
			this.fail(error);
			return Promise.resolve({ ok: false, error });
		}
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
	 * Delete a playlist on the server, then re-read. Failures land in the
	 * snapshot's `error` — the confirm dialog closes before the result
	 * arrives, so the list banner is where the user still is.
	 */
	async remove(id: number): Promise<void> {
		const result = await mutate(
			() => bun.deletePlaylist({ id }),
			"Deleting the playlist failed",
		);
		if (result.ok) void libraryData.refresh();
		else this.fail(result.error);
	}

	private byId(playlistId: number): RemotePlaylist | undefined {
		return this.snapshot.playlists.find(
			(playlist) => playlist.id === playlistId,
		);
	}

	private fail(error: string): void {
		this.mutationError = error;
		this.update({ error });
	}

	private update(patch: Partial<PlaylistsState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — playlist state must survive component unmounts. */
export const playlistService = new PlaylistService();
