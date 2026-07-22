import { playerController } from "@/hooks/usePlayer";
import { CacheBuster } from "@/lib/cacheBuster";
import type { Track } from "@/player/types";
import type { EditTrackParams, RemoteTrack } from "../../shared/rpcSchema";
import { bun } from "./rpc";
import { sessionService } from "./SessionService";

/** Immutable snapshot of the server-library state, consumed by React. */
export interface LibraryState {
	loading: boolean;
	error: string | null;
}

/** Result shape for track mutations the context menu shows inline. */
export type MutationResult = { ok: true } | { ok: false; error: string };

/** The mutable fields of an edit — everything except the track id. */
export type EditTrackChanges = Omit<EditTrackParams, "id">;

/**
 * Owns the server library: fetches it when a session starts and queues the
 * tracks (they stream progressively through the bun proxy), and clears the
 * queue when the session ends — the stream URLs are only valid against the
 * session that produced them, so letting them survive a re-login would play
 * another server's audio under stale metadata.
 */
export class LibraryService {
	private subscribers = new Set<() => void>();
	private snapshot: LibraryState = { loading: false, error: null };
	private fetchSeq = 0;
	// Server metadata for each queued remote track, keyed by the queue track
	// id (`server-<id>`). The context menu reads it to map a queued Track back
	// to its numeric server id and currently-linked artist names.
	private remoteById = new Map<string, RemoteTrack>();
	// The StreamProxy cover URL for a track never changes and forwards no cache
	// headers, so after a cover is replaced we bust it (keyed by queue track id)
	// to force Chromium to re-fetch. See CacheBuster.
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
				playerController.removeTracks(() => true);
				this.update({ loading: false, error: null });
			}
		});
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): LibraryState => this.snapshot;

	/** Server metadata for a queued remote track, or undefined for locals. */
	getRemote(trackId: string): RemoteTrack | undefined {
		return this.remoteById.get(trackId);
	}

	/**
	 * Re-fetch the server library and queue tracks that aren't queued yet.
	 * Resolves `true` once a fresh list has been applied (or a newer refresh
	 * has superseded this one and will apply it), `false` if the fetch failed
	 * — callers that just uploaded a track use this to know it actually landed
	 * in the queue before dropping their pending placeholder.
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
		// Apply the cover cache-buster once so getRemote (dialog preview) and the
		// queue rows all see the same busted URL. Newest first (descending id) so
		// the empty-queue preload picks the newest track, matching the sorted list.
		const remotes = result.tracks
			.map((remote) => ({
				...remote,
				coverUrl: this.coverCache.apply(trackIdFor(remote), remote.coverUrl),
			}))
			.sort((a, b) => b.id - a.id);
		this.remoteById = new Map(
			remotes.map((remote) => [trackIdFor(remote), remote]),
		);
		// Update already-queued tracks (e.g. artists changed) in place — the
		// queue dedupes by id so addTracks alone wouldn't refresh them...
		for (const remote of remotes) {
			playerController.updateTrack(trackIdFor(remote), {
				title: remote.title,
				artist: remote.artist,
				coverUrl: remote.coverUrl,
				durationSec: remote.durationMs / 1000,
			});
		}
		// ...then append the ones that are new on the server.
		playerController.addTracks(remotes.map(toTrack));
		// Server ids increase with upload order, so sorting the queue by id
		// descending puts the newest uploads at the top — including one that was
		// just uploaded and would otherwise land at the end of the queue.
		playerController.sortTracks((a, b) => serverIdOf(b) - serverIdOf(a));
		this.update({ loading: false, error: null });
		return true;
	}

	/**
	 * Delete a server track, then drop it from the queue. Failures land in the
	 * snapshot's `error` (the confirm dialog has already closed, so the App
	 * banner is where the user still is).
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
		playerController.removeTracks((track) => track.id === trackId);
	}

	/**
	 * Edit a server track (title, cover, and/or artist links), then refetch so
	 * the queued track updates. Returns the outcome instead of writing to the
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
		// refresh maps it onto the queue and dialog preview.
		if (changes.coverBase64 !== undefined) this.coverCache.bump(trackId);
		void this.refresh();
		return { ok: true };
	}

	private update(patch: Partial<LibraryState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** Stable queue id for a server track, so refreshes dedupe against the queue. */
function trackIdFor(remote: RemoteTrack): string {
	return `server-${remote.id}`;
}

/** Recover the numeric server id from a queue track id (`server-<id>`). */
function serverIdOf(track: Track): number {
	const id = Number(track.id.slice("server-".length));
	return Number.isFinite(id) ? id : 0;
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
