import type {
	CreateArtistParams,
	RemoteArtist,
} from "../../shared/rpcSchema";
import { bun } from "./rpc";
import { sessionService } from "./SessionService";

/** Immutable snapshot of the server artist list, consumed by React. */
export interface ArtistsState {
	artists: RemoteArtist[];
	loading: boolean;
	/** List-level error (fetch or delete failures). */
	error: string | null;
}

/**
 * Owns the server artist list: fetches it when a session starts and clears
 * it when the session ends (artist data is session-scoped). Mutations
 * (create/delete) refetch instead of patching locally — the server assigns
 * ids, so it stays the single source of truth.
 */
export class ArtistService {
	private subscribers = new Set<() => void>();
	private snapshot: ArtistsState = {
		artists: [],
		loading: false,
		error: null,
	};
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
				this.update({ artists: [], loading: false, error: null });
			}
		});
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): ArtistsState => this.snapshot;

	/** Re-fetch the artist list from the server. */
	async refresh(): Promise<void> {
		const seq = ++this.fetchSeq;
		this.update({ loading: true, error: null });
		let result;
		try {
			result = await bun.listArtists();
		} catch (err) {
			// RPC transport failure or timeout (e.g. bun process unreachable).
			if (seq !== this.fetchSeq) return;
			this.update({
				loading: false,
				error:
					err instanceof Error ? err.message : "Failed to load artists",
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
		this.update({ artists: result.artists, loading: false, error: null });
	}

	/**
	 * Create an artist on the server, then refetch. Returns the outcome
	 * instead of writing `error` to the snapshot so the create dialog can
	 * show the failure inline and stay open.
	 */
	async create(
		input: CreateArtistParams,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		let result;
		try {
			result = await bun.createArtist(input);
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : "Creating the artist failed",
			};
		}
		if (!result.ok) {
			if (result.status === 401) {
				sessionService.markExpired("Session expired — please log in again.");
			}
			return { ok: false, error: result.error };
		}
		void this.refresh();
		return { ok: true };
	}

	/**
	 * Delete an artist on the server, then refetch. Failures land in the
	 * snapshot's `error` — the confirm dialog closes before the result
	 * arrives, so the list banner is where the user still is.
	 */
	async remove(id: number): Promise<void> {
		let result;
		try {
			result = await bun.deleteArtist({ id });
		} catch (err) {
			this.update({
				error:
					err instanceof Error ? err.message : "Deleting the artist failed",
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

	private update(patch: Partial<ArtistsState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — artist state must survive component unmounts. */
export const artistService = new ArtistService();
