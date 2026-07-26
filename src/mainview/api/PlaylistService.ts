import { playerController } from "@/hooks/usePlayer";
import { CacheBuster } from "@/lib/cacheBuster";
import type { Track } from "@/player/types";
import type {
	CreatePlaylistParams,
	EditPlaylistParams,
	RemotePlaylist,
} from "../../shared/rpcSchema";
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
 * of truth. Track membership is edited by full replacement of the ordered
 * `trackIds` (that's the whole contract; add/remove/reorder are conveniences
 * over it).
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
				this.update({ playlists: [], loading: false, error: null });
			}
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

	/**
	 * What every playlist-level play button does (grid card, detail header,
	 * sidebar row): if the playlist already owns the queue, toggle pause/resume
	 * in place; otherwise replace the queue with it and start from the top.
	 */
	playOrToggle(playlist: RemotePlaylist): void {
		if (playerController.queueContextId === playlistQueueContext(playlist.id)) {
			playerController.togglePlay();
		} else {
			this.play(playlist);
		}
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
			trackIds: [...new Set(playlist.trackIds)],
			imageUrl: this.imageCache.apply(String(playlist.id), playlist.imageUrl),
		}));
		this.update({ playlists, loading: false, error: null });
		this.syncQueue();
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

	// Membership edits read the snapshot's trackIds and send a full
	// replacement, so two running concurrently would clobber each other — the
	// later one is computed from a list that lacks the earlier one's change
	// (e.g. quick successive adds from the picker would drop all but the last).
	// Chaining them makes each op read the list the previous one's refetch
	// produced. Ops never reject (edit() returns failures), but the chain
	// swallows rejections anyway so one bug can't wedge it forever.
	private membershipChain: Promise<unknown> = Promise.resolve();

	private chainMembershipEdit(
		playlistId: number,
		buildTrackIds: (current: readonly number[]) => number[] | null,
	): Promise<MutationResult> {
		const run = this.membershipChain.then(
			async (): Promise<MutationResult> => {
				const playlist = this.byId(playlistId);
				if (!playlist) return { ok: false, error: "Playlist not found." };
				const trackIds = buildTrackIds(playlist.trackIds);
				if (trackIds === null) return { ok: true }; // no-op edit
				const result = await this.edit({ id: playlistId, trackIds });
				// Row menus and the add picker fire-and-forget these, so a
				// failure also lands in the snapshot's error banner.
				if (!result.ok) this.update({ error: result.error });
				return result;
			},
		);
		this.membershipChain = run.catch(() => undefined);
		return run;
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
		serverTrackIds: number[],
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
		serverTrackIds: number[],
	): Promise<MutationResult> {
		return this.chainMembershipEdit(playlistId, (current) => {
			const trackIds = current.filter((id) => !serverTrackIds.includes(id));
			return trackIds.length === current.length ? null : trackIds;
		});
	}

	/**
	 * Swap a track with its neighbour above/below. Addressed by server id, not
	 * list position: membership edits are chained, so a queued op runs against
	 * the list its predecessor produced — a position captured at render time
	 * could name the wrong entry by then, while the id (unique per playlist)
	 * still finds the right one.
	 */
	moveTrack(
		playlistId: number,
		serverTrackId: number,
		direction: -1 | 1,
	): Promise<MutationResult> {
		return this.chainMembershipEdit(playlistId, (current) => {
			const position = current.indexOf(serverTrackId);
			if (position === -1) return null;
			const target = position + direction;
			if (target < 0 || target >= current.length) return null;
			const trackIds = [...current];
			[trackIds[position], trackIds[target]] = [
				trackIds[target],
				trackIds[position],
			];
			return trackIds;
		});
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

	private update(patch: Partial<PlaylistsState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — playlist state must survive component unmounts. */
export const playlistService = new PlaylistService();
