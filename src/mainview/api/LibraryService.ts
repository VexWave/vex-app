import { playerController } from "@/hooks/usePlayer";
import type { Track } from "@/player/types";
import type { RemoteTrack } from "../../shared/rpcSchema";
import { bun } from "./rpc";
import { sessionService } from "./SessionService";

/** Immutable snapshot of the server-library state, consumed by React. */
export interface LibraryState {
	loading: boolean;
	error: string | null;
}

/**
 * Owns the server library: fetches it when a session starts and queues the
 * tracks (they stream progressively through the bun proxy), and removes all
 * remote tracks when the session ends — their stream URLs are only valid
 * against the session that produced them, so letting them survive a
 * re-login would play another server's audio under stale metadata.
 */
export class LibraryService {
	private subscribers = new Set<() => void>();
	private snapshot: LibraryState = { loading: false, error: null };
	private fetchSeq = 0;

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
				playerController.removeTracks((track) => track.origin === "remote");
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

	/** Re-fetch the server library and queue tracks that aren't queued yet. */
	async refresh(): Promise<void> {
		const seq = ++this.fetchSeq;
		this.update({ loading: true, error: null });
		let result;
		try {
			result = await bun.listTracks();
		} catch (err) {
			// RPC transport failure or timeout (e.g. bun process unreachable).
			if (seq !== this.fetchSeq) return;
			this.update({
				loading: false,
				error:
					err instanceof Error ? err.message : "Failed to load server library",
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
		// The queue skips ids that are already present, so a refresh only
		// appends tracks that are new on the server.
		playerController.addTracks(result.tracks.map(toTrack));
		this.update({ loading: false, error: null });
	}

	private update(patch: Partial<LibraryState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

function toTrack(remote: RemoteTrack): Track {
	return {
		// Stable per server track, so refreshes dedupe against the queue.
		id: `server-${remote.id}`,
		origin: "remote",
		title: remote.title,
		artist: remote.artist,
		durationSec: remote.durationSec,
		src: remote.streamUrl,
	};
}

/** App-wide singleton — library state must survive component unmounts. */
export const libraryService = new LibraryService();
