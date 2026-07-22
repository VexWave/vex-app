import type {
	CreateArtistParams,
	EditArtistParams,
	RemoteArtist,
} from "../../shared/rpcSchema";
import { findMatchingArtist } from "@/lib/artistMatch";
import { CacheBuster } from "@/lib/cacheBuster";
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
	// The StreamProxy avatar URL for an artist never changes and forwards no
	// cache headers, so after an avatar is replaced we bust it (keyed by artist
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
		// Bust replaced avatars: their imageUrl is stable, so map the fresh list
		// through the cache-buster before it reaches the UI.
		const artists = result.artists.map((artist) => ({
			...artist,
			imageUrl: this.imageCache.apply(String(artist.id), artist.imageUrl),
		}));
		this.update({ artists, loading: false, error: null });
	}

	/**
	 * Create an artist on the server, then refetch. The refetch is awaited so
	 * the new artist is in the snapshot by the time this resolves. Returns the
	 * outcome instead of writing `error` to the snapshot so the create dialog can
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
		await this.refresh();
		return { ok: true };
	}

	/**
	 * Resolve a proposed artist (from a URL import) to an existing id, creating
	 * it first when nothing matches. Fuzzy-matches by name so casing/punctuation/
	 * near-duplicate variants reuse the existing artist instead of spawning a
	 * duplicate; only a genuine miss creates a new one (with the fetched avatar).
	 * Returns the linkable id, or a failure the caller can surface inline.
	 */
	async resolveOrCreate(
		input: CreateArtistParams,
	): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
		// The already-loaded list answers the common case. Only a miss is worth a
		// round-trip: the dialog may have been open a while, and another import
		// could have created this artist since.
		const known = findMatchingArtist(input.name, this.snapshot.artists);
		if (known) return { ok: true, id: known.id };
		await this.refresh();
		const existing = findMatchingArtist(input.name, this.snapshot.artists);
		if (existing) return { ok: true, id: existing.id };

		// The create route returns no id, so the artist has to be located by name
		// in the list create() refetched — an exact match by now.
		const created = await this.create(input);
		if (!created.ok) return created;
		const now = findMatchingArtist(input.name, this.snapshot.artists);
		if (!now) {
			return {
				ok: false,
				error: "Artist was created but could not be found afterwards.",
			};
		}
		return { ok: true, id: now.id };
	}

	/**
	 * Edit an artist's name and/or avatar on the server, then refetch. Like
	 * `create`, returns the outcome so the edit dialog can show a failure inline
	 * and stay open.
	 */
	async edit(
		input: EditArtistParams,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		let result;
		try {
			result = await bun.editArtist(input);
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : "Editing the artist failed",
			};
		}
		if (!result.ok) {
			if (result.status === 401) {
				sessionService.markExpired("Session expired — please log in again.");
			}
			return { ok: false, error: result.error };
		}
		// The avatar URL is stable, so bust it when the image changed (new bytes
		// or removal) before the refresh maps it onto the list.
		if (input.imageBase64 !== undefined) this.imageCache.bump(String(input.id));
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
