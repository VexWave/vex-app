import { playerController } from "@/hooks/usePlayer";
import { CacheBuster } from "@/lib/cacheBuster";
import type { Track } from "@/player/types";
import type { EditTrackParams, RemoteTrack } from "../../shared/rpcSchema";
import { bun } from "./rpc";
import { sessionService } from "./SessionService";

/**
 * Queue context id for "the queue mirrors the whole library" (see
 * PlayerController.queueContextId). Playing a playlist or an artist replaces
 * it with that collection's own context id.
 */
export const LIBRARY_QUEUE_CONTEXT = "library";

/** Immutable snapshot of the server-library state, consumed by React. */
export interface LibraryState {
	/** Server library, newest first — what the Library view renders. */
	tracks: Track[];
	loading: boolean;
	error: string | null;
}

/** Result shape for track mutations the context menu shows inline. */
export type MutationResult = { ok: true } | { ok: false; error: string };

/** The mutable fields of an edit — everything except the track id. */
export type EditTrackChanges = Omit<EditTrackParams, "id">;

/**
 * Owns the server library: fetches it when a session starts and clears it
 * (and the play queue) when the session ends — the stream URLs are only valid
 * against the session that produced them, so letting them survive a re-login
 * would play another server's audio under stale metadata.
 *
 * The library list itself lives in this snapshot; the play queue only mirrors
 * it while the library is what the user played from (queue context). When a
 * playlist or an artist owns the queue, refreshes still patch queued copies'
 * metadata and drop server-deleted tracks, but membership stays that
 * collection's.
 */
export class LibraryService {
	private subscribers = new Set<() => void>();
	private snapshot: LibraryState = { tracks: [], loading: false, error: null };
	private fetchSeq = 0;
	// Server metadata for each library track, keyed by the track id
	// (`server-<id>`). The context menu reads it to map a Track back to its
	// server id and currently-linked artist names.
	private remoteById = new Map<string, RemoteTrack>();
	// The StreamProxy cover URL for a track never changes and forwards no cache
	// headers, so after a cover is replaced we bust it (keyed by track id) to
	// force Chromium to re-fetch. See CacheBuster.
	private coverCache = new CacheBuster();

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
				this.remoteById.clear();
				this.coverCache.clear();
				// Every queued track streams from this session's server, so the
				// whole queue is invalidated when the session ends.
				playerController.clearQueue();
				this.update({ tracks: [], loading: false, error: null });
			}
		});
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): LibraryState => this.snapshot;

	/** Server metadata for a library track, or undefined for unknown ids. */
	getRemote(trackId: string): RemoteTrack | undefined {
		return this.remoteById.get(trackId);
	}

	/**
	 * Re-fetch the server library. Resolves `true` once a fresh list has been
	 * applied (or a newer refresh has superseded this one and will apply it),
	 * `false` if the fetch failed — callers that just uploaded a track use this
	 * to know it actually landed before dropping their pending placeholder.
	 */
	async refresh(): Promise<boolean> {
		const seq = ++this.fetchSeq;
		this.update({ loading: true, error: null });
		let result;
		try {
			result = await bun.listTracks();
		} catch (err) {
			// RPC transport failure or timeout (e.g. bun process unreachable).
			if (seq !== this.fetchSeq) return true; // superseded by a newer refresh
			this.update({
				loading: false,
				error:
					err instanceof Error ? err.message : "Failed to load server library",
			});
			return false;
		}
		if (seq !== this.fetchSeq) return true; // superseded by a newer refresh
		if (!result.ok) {
			if (result.status === 401) {
				sessionService.markExpired("Session expired — please log in again.");
			}
			this.update({ loading: false, error: result.error });
			return false;
		}
		// Apply the cover cache-buster once so getRemote (dialog preview) and
		// the list rows all see the same busted URL. A track id is a uuid and
		// sorts arbitrarily, so upload order is the server's listing order
		// (oldest first, per the contract) — reversed here to put the newest
		// uploads on top.
		const remotes = result.tracks
			.map((remote) => ({
				...remote,
				coverUrl: this.coverCache.apply(trackIdFor(remote), remote.coverUrl),
			}))
			.reverse();
		this.remoteById = new Map(
			remotes.map((remote) => [trackIdFor(remote), remote]),
		);
		const tracks = remotes.map(toTrack);
		this.update({ tracks, loading: false, error: null });
		this.syncQueue(tracks);
		return true;
	}

	/**
	 * Push a fresh library into the play queue. When the library owns the
	 * queue (or nothing is queued yet — fresh login), the queue mirrors it
	 * outright. When another collection owns it, only queued copies' metadata
	 * is patched and server-deleted tracks are dropped; membership itself is
	 * that collection's service's business.
	 */
	private syncQueue(tracks: Track[]): void {
		const context = playerController.queueContextId;
		if (context === null || context === LIBRARY_QUEUE_CONTEXT) {
			playerController.syncCollection(LIBRARY_QUEUE_CONTEXT, tracks);
			return;
		}
		for (const track of tracks) {
			playerController.updateTrack(track.id, {
				title: track.title,
				artist: track.artist,
				coverUrl: track.coverUrl,
				durationSec: track.durationSec,
			});
		}
		playerController.removeTracks((track) => !this.remoteById.has(track.id));
	}

	/**
	 * Delete a server track, then drop it from the library and the queue.
	 * Failures land in the snapshot's `error` (the confirm dialog has already
	 * closed, so the App banner is where the user still is).
	 */
	async removeTrack(trackId: string): Promise<void> {
		const remote = this.remoteById.get(trackId);
		if (!remote) return;
		let result;
		try {
			result = await bun.deleteTrack({ id: remote.id });
		} catch (err) {
			this.update({
				error: err instanceof Error ? err.message : "Deleting the track failed",
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
		this.remoteById.delete(trackId);
		this.update({
			tracks: this.snapshot.tracks.filter((track) => track.id !== trackId),
		});
		// The server also drops the track from every playlist; the playlist
		// join skips ids missing from the library, so stale trackIds are
		// harmless until the next playlists refresh.
		playerController.removeTracks((track) => track.id === trackId);
	}

	/**
	 * Edit a server track (title, cover, and/or artist links), then refetch so
	 * the list and queue update. Returns the outcome instead of writing to the
	 * snapshot so the edit dialog can show it inline.
	 */
	async editTrack(
		trackId: string,
		changes: EditTrackChanges,
	): Promise<MutationResult> {
		const remote = this.remoteById.get(trackId);
		if (!remote) {
			return { ok: false, error: "Only server tracks can be edited." };
		}
		let result;
		try {
			result = await bun.editTrack({ id: remote.id, ...changes });
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : "Editing the track failed",
			};
		}
		if (!result.ok) {
			if (result.status === 401) {
				sessionService.markExpired("Session expired — please log in again.");
			}
			return { ok: false, error: result.error };
		}
		// The cover URL is stable, so bust it to force a re-fetch before the
		// refresh maps it onto the list and dialog preview.
		if (changes.coverBase64 !== undefined) this.coverCache.bump(trackId);
		void this.refresh();
		return { ok: true };
	}

	private update(patch: Partial<LibraryState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** Stable track id for a server track (`server-<id>`), shared with the queue. */
function trackIdFor(remote: RemoteTrack): string {
	return `server-${remote.id}`;
}

/** The queue/list id a server track id maps to (the trackIdFor counterpart). */
export function trackIdForServerId(serverId: string): string {
	return `server-${serverId}`;
}

function toTrack(remote: RemoteTrack): Track {
	return {
		id: trackIdFor(remote),
		title: remote.title,
		artist: remote.artist,
		// ms→s at the player boundary: Track.durationSec / AudioPlayer /
		// PlayerBar / formatTime all live in the seconds domain, matching
		// HTMLAudioElement.
		durationSec: remote.durationMs / 1000,
		coverUrl: remote.coverUrl,
		src: remote.streamUrl,
	};
}

/** App-wide singleton — library state must survive component unmounts. */
export const libraryService = new LibraryService();
