import type {
	CreateArtistParams,
	EditArtistParams,
	RemoteArtist,
} from "../../shared/rpcSchema";
import { playerController } from "@/hooks/usePlayer";
import { findMatchingArtist } from "@/lib/artistMatch";
import { CacheBuster } from "@/lib/cacheBuster";
import type { Track } from "@/player/types";
import { submitIdList } from "./idListEdit";
import type { IdListDraft } from "./idListEdit";
import { libraryService } from "./LibraryService";
import { bun } from "./rpc";
import { sessionService } from "./SessionService";

/** Queue context id for "the queue is this artist's tracks" (see PlayerController). */
export function artistQueueContext(artistId: number): string {
	return `artist-${artistId}`;
}

/** Immutable snapshot of the server artist list, consumed by React. */
export interface ArtistsState {
	artists: RemoteArtist[];
	loading: boolean;
	/** List-level error (fetch, delete and fire-and-forget unlink failures). */
	error: string | null;
}

/**
 * Owns the server artist list: fetches it when a session starts and clears
 * it when the session ends (artist data is session-scoped). Mutations
 * (create/edit/delete) refetch instead of patching locally — the server assigns
 * ids, so it stays the single source of truth.
 *
 * An artist is also a playable collection: `tracksOf` projects the library onto
 * one artist and `play` makes that projection the queue, tagged with the
 * artist's own context id (see PlayerController.queueContextId).
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
	// Renames in flight; while any is, the queue projection is untrustworthy
	// (see `edit` and `syncQueue`). A counter, not a flag: two renames can
	// overlap, and the second must not release the first one's hold.
	private renamesInFlight = 0;

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

		// An artist's tracks are a projection of the library, so the library —
		// not this list — is what changes them: a track uploaded, deleted, or
		// (un)linked to the artist. Only the track list itself matters, and it
		// keeps its identity across the loading flags every refresh emits.
		let lastTracks = libraryService.getSnapshot().tracks;
		libraryService.subscribe(() => {
			const { tracks } = libraryService.getSnapshot();
			if (tracks === lastTracks) return;
			lastTracks = tracks;
			this.syncQueue();
		});
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): ArtistsState => this.snapshot;

	/**
	 * The artist's tracks, in library order (newest first).
	 *
	 * The join is by name: a track listing carries its artists' *names*, not
	 * their ids (see RemoteTrack.artists), and those names are the server's own
	 * copy of the records in this list — so an exact match is the link itself,
	 * not a guess (unlike the fuzzy import matching in lib/artistMatch). Two
	 * artists sharing one name consequently share a track list; that ambiguity
	 * exists server-side and the client can't resolve it.
	 */
	tracksOf(artist: RemoteArtist): Track[] {
		return libraryService
			.getSnapshot()
			.tracks.filter(
				(track) =>
					libraryService.getRemote(track.id)?.artists.includes(artist.name) ??
					false,
			);
	}

	/**
	 * How many library tracks each artist name is credited on, in one pass over
	 * the library — for lists that need a number per artist (the grid) rather
	 * than one artist's tracks. Keyed by name for the same reason `tracksOf`
	 * joins on it.
	 */
	trackCountsByName(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const track of libraryService.getSnapshot().tracks) {
			for (const name of libraryService.getRemote(track.id)?.artists ?? []) {
				counts.set(name, (counts.get(name) ?? 0) + 1);
			}
		}
		return counts;
	}

	/**
	 * Make the artist's tracks the play queue and start at `index` (of that
	 * list). Later library edits keep the queue in sync via `syncQueue`.
	 */
	play(artist: RemoteArtist, index = 0): void {
		playerController.playCollection(
			artistQueueContext(artist.id),
			this.tracksOf(artist),
			index,
		);
	}

	/** Play the artist, or toggle playback when it already owns the queue. */
	playOrToggle(artist: RemoteArtist): void {
		playerController.playOrToggleCollection(
			artistQueueContext(artist.id),
			this.tracksOf(artist),
		);
	}

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
		// through the cache-buster before it reaches the UI. Sorted by name so
		// every artist list in the app (the grid, the track dialog's picker) is
		// in the same findable order; the server returns insertion order.
		const artists = result.artists
			.map((artist) => ({
				...artist,
				imageUrl: this.imageCache.apply(String(artist.id), artist.imageUrl),
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
		this.update({ artists, loading: false, error: null });
		this.syncQueue();
	}

	/**
	 * If an artist currently owns the play queue, mirror its fresh track list
	 * into it — so a track linked to (or unlinked from) the artist while it
	 * plays takes effect. An artist that was deleted leaves the queue playing
	 * its last known content (its context id just goes stale, which is
	 * harmless).
	 */
	private syncQueue(): void {
		// Mid-rename the two sides of the name join disagree (see `edit`), and
		// the projection would come back empty — which now stops playback.
		if (this.renamesInFlight > 0) return;
		const context = playerController.queueContextId;
		if (context === null) return;
		const artist = this.snapshot.artists.find(
			(candidate) => artistQueueContext(candidate.id) === context,
		);
		if (!artist) return;
		playerController.syncCollection(context, this.tracksOf(artist));
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
		// Read before the request: the refetch below replaces the snapshot, and
		// only an actual rename has to reach the library (see the end of this
		// method). The dialog submits the name whether or not it was touched.
		const renamed =
			input.name !== undefined &&
			input.name !== this.snapshot.artists.find(({ id }) => id === input.id)?.name;
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
		if (!renamed) {
			void this.refresh();
			return { ok: true };
		}
		// Every linked track carries this artist's name — as its displayed
		// artist line and as the key `tracksOf` joins on — so a rename leaves
		// the library stale (the artist would appear to have lost its tracks)
		// until it is refetched too. (An avatar-only edit changes nothing there,
		// hence the plain refresh above.)
		//
		// The two land in either order, and until both have, one of them still
		// carries the old name and the projection between them is empty — which
		// would stop playback if this artist owns the queue. So queue syncing is
		// held off until they agree, then run once.
		this.renamesInFlight += 1;
		void Promise.allSettled([this.refresh(), libraryService.refresh()]).then(
			() => {
				this.renamesInFlight -= 1;
				this.syncQueue();
			},
		);
		return { ok: true };
	}

	/**
	 * Unlink a track from this artist, leaving the track and its other artists
	 * alone. The edit route replaces a track's links by id while the track only
	 * carries its artists' names, so the names that stay are resolved back to
	 * ids through this list — and a name that resolves to nothing means this
	 * list is behind, which `submitIdList` answers by refetching and building
	 * again. Failures land in the snapshot's `error` — the row menu that
	 * triggers this is long gone by the time one arrives.
	 */
	async unlinkTrack(artist: RemoteArtist, trackId: string): Promise<void> {
		const result = await submitIdList({
			build: () => this.linksWithout(artist, trackId),
			send: (artistIds) => libraryService.editTrack(trackId, { artistIds }),
			// The names come from the library, the ids from this list, so a build
			// that couldn't reconcile them needs both refetched. Settled, not
			// all: one list failing to load must still let the other through.
			resync: () =>
				Promise.allSettled([this.refresh(), libraryService.refresh()]),
			staleError: `“${artist.name}” could not be unlinked — the artist list is out of date.`,
		});
		if (!result.ok) this.update({ error: result.error });
	}

	/**
	 * The artist ids a track keeps once `artist` is unlinked — its links minus
	 * this one, since the edit replaces the whole set.
	 *
	 * The track carries its artists' *names*, so each one is resolved against
	 * this list to get an id back. A name nothing answers to leaves the set
	 * unbuildable rather than one member short: sending it short would unlink
	 * an artist nobody asked to unlink.
	 */
	private linksWithout(
		artist: RemoteArtist,
		trackId: string,
	): IdListDraft<number> {
		const remote = libraryService.getRemote(trackId);
		if (!remote) return "noop"; // not a library track — nothing to unlink
		const idsByName = new Map(
			this.snapshot.artists.map((candidate) => [candidate.name, candidate.id]),
		);
		const artistIds: number[] = [];
		for (const name of remote.artists) {
			// Compared by name, not id: a same-named duplicate artist is
			// indistinguishable from this one in the UI, so both links go.
			if (name === artist.name) continue;
			const id = idsByName.get(name);
			if (id === undefined) return "stale";
			artistIds.push(id);
		}
		return artistIds;
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
		// The server keeps the tracks but drops their links to this artist, so
		// their artist lines would keep naming it until the library refetches.
		void libraryService.refresh();
	}

	private update(patch: Partial<ArtistsState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — artist state must survive component unmounts. */
export const artistService = new ArtistService();
