import type {
	CreateArtistParams,
	EditArtistParams,
	RemoteArtist,
} from "../../shared/rpcSchema";
import { playerController } from "@/hooks/usePlayer";
import { findMatchingArtist } from "@/lib/artistMatch";
import type { Track } from "@/player/types";
import { submitIdList } from "./idListEdit";
import type { IdListDraft } from "./idListEdit";
import { libraryData } from "./LibraryData";
import { libraryService } from "./LibraryService";
import { mutate } from "./mutate";
import type { MutationResult } from "./mutate";
import { bun } from "./rpc";

/** Queue context id for "the queue is this artist's tracks" (see PlayerController). */
export function artistQueueContext(artistId: number): string {
	return `artist-${artistId}`;
}

/** Immutable snapshot of the server artist list, consumed by React. */
export interface ArtistsState {
	artists: RemoteArtist[];
	loading: boolean;
	/** List-level error (the read's, or a delete/unlink that failed). */
	error: string | null;
}

/**
 * The server's artists, sorted by name. Mutations write and then re-read
 * `libraryData` rather than patching locally — the server assigns ids, so it
 * stays the single source of truth.
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
	// The last mutation's failure, until the next read clears it.
	private mutationError: string | null = null;
	// The payload the sorted list above was built from; see LibraryService.
	private builtFrom: RemoteArtist[] = libraryData.getSnapshot().artists;

	constructor() {
		// One payload carries both this list and the library it projects onto,
		// so one subscription answers a track uploaded, deleted or (un)linked
		// as much as an artist created or renamed. `LibraryService` rebuilds
		// its indices off the same store and subscribes to it first, so they
		// are current by the time `apply` reads them.
		libraryData.subscribe(() => this.apply());
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
	 * The join is by id — a track names the artists it is credited to (see
	 * `RemoteTrack.artistIds`), and both sides come from the same read — so two
	 * artists sharing a name keep separate track lists.
	 */
	tracksOf(artist: RemoteArtist): Track[] {
		return libraryService.tracksOfArtist(artist.id);
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

	/** Rebuild the sorted list from the library payload, then republish. */
	private apply(): void {
		const data = libraryData.getSnapshot();
		if (data.loading) this.mutationError = null;
		const error = this.mutationError ?? data.error;
		if (data.artists === this.builtFrom) {
			this.update({ loading: data.loading, error });
			return;
		}
		this.builtFrom = data.artists;
		// Sorted by name so every artist list in the app (the grid, the track
		// dialog's picker) is in the same findable order; the server returns
		// insertion order.
		const artists = [...data.artists].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		this.update({ artists, loading: data.loading, error });
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
		const context = playerController.queueContextId;
		if (context === null) return;
		const artist = this.snapshot.artists.find(
			(candidate) => artistQueueContext(candidate.id) === context,
		);
		if (!artist) return;
		playerController.syncCollection(context, this.tracksOf(artist));
	}

	/**
	 * Create an artist on the server, then re-read. The read is awaited so the
	 * new artist is in the snapshot by the time this resolves. Returns the
	 * outcome instead of writing `error` to the snapshot so the create dialog can
	 * show the failure inline and stay open.
	 */
	async create(input: CreateArtistParams): Promise<MutationResult> {
		const result = await mutate(
			() => bun.createArtist(input),
			"Creating the artist failed",
		);
		if (result.ok) await libraryData.refresh();
		return result;
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
		await libraryData.refresh();
		const existing = findMatchingArtist(input.name, this.snapshot.artists);
		if (existing) return { ok: true, id: existing.id };

		// The create route returns no id, so the artist has to be located by name
		// in the list create() re-read — an exact match by now.
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
	 * Edit an artist's name and/or avatar on the server, then re-read. Like
	 * `create`, returns the outcome so the edit dialog can show a failure inline
	 * and stay open.
	 */
	async edit(input: EditArtistParams): Promise<MutationResult> {
		const result = await mutate(
			() => bun.editArtist(input),
			"Editing the artist failed",
		);
		// A rename changes only what is displayed: tracks link to this artist by
		// id, so nothing about the projection moves under it and one read carries
		// both sides of the change at once.
		if (result.ok) void libraryData.refresh();
		return result;
	}

	/**
	 * Unlink a track from this artist, leaving the track and its other artists
	 * alone. The edit route replaces a track's links as one list, so it goes
	 * through `submitIdList` — a track that died under the edit is answered by
	 * rebuilding rather than by failing at the user. Failures land in the
	 * snapshot's `error`: the row menu that triggered this is long gone by the
	 * time one arrives.
	 */
	async unlinkTrack(artist: RemoteArtist, trackId: string): Promise<void> {
		const result = await submitIdList({
			build: () => this.linksWithout(artist, trackId),
			send: (artistIds) => libraryService.editTrack(trackId, { artistIds }),
			staleError: `“${artist.name}” could not be unlinked — the library is out of date.`,
		});
		if (!result.ok) this.fail(result.error);
	}

	/**
	 * The artist ids a track keeps once `artist` is unlinked — its links minus
	 * this one, since the edit replaces the whole set.
	 */
	private linksWithout(
		artist: RemoteArtist,
		trackId: string,
	): IdListDraft<number> {
		const remote = libraryService.getRemote(trackId);
		if (!remote) return "noop"; // not a library track — nothing to unlink
		return remote.artistIds.filter((id) => id !== artist.id);
	}

	/**
	 * Delete an artist on the server, then re-read. Failures land in the
	 * snapshot's `error` — the confirm dialog closes before the result
	 * arrives, so the list banner is where the user still is.
	 */
	async remove(id: number): Promise<void> {
		const result = await mutate(
			() => bun.deleteArtist({ id }),
			"Deleting the artist failed",
		);
		// The server keeps the tracks and drops their links to this artist; one
		// read carries both, so the credit lines never name an artist that is
		// already gone.
		if (result.ok) void libraryData.refresh();
		else this.fail(result.error);
	}

	private fail(error: string): void {
		this.mutationError = error;
		this.update({ error });
	}

	private update(patch: Partial<ArtistsState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — artist state must survive component unmounts. */
export const artistService = new ArtistService();
