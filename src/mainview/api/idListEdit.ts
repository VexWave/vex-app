import type { MutationResult } from "./LibraryService";

/**
 * The list a write wants to send: the ids themselves, `"noop"` when the state
 * it wants already holds, or `"stale"` when what the service currently mirrors
 * can't name the server's state well enough to build one.
 */
export type IdListDraft<Id extends string | number> = Id[] | "noop" | "stale";

/**
 * Submit a write that replaces a whole list of server ids — a playlist's
 * `trackIds`, a track's `artistIds`.
 *
 * The server validates such a list as a unit: a single id it no longer knows
 * rejects the entire edit (400). Ids die behind the client's back — deleting a
 * track drops it from every playlist, deleting an artist unlinks it from every
 * track — so any list built from a mirror of server state can carry a dead id,
 * and a mirror that isn't refetched keeps building the same doomed list.
 *
 * The way out is to send an *intent* rather than a list: `build` recomputes it
 * from whatever the service holds at that moment, so it can be run again after
 * `resync` has replaced that state with the server's. Callers therefore never
 * hand over a precomputed array.
 *
 * A rejection is diagnosed by rebuilding, not by reading the server's message:
 * if the resync changes what the intent produces, the list was stale and the
 * rebuilt one goes out. If it rebuilds identically there is nothing stale to
 * explain the rejection, so the original error stands rather than being sent a
 * second time to fail the same way. At most one retry — an edit the server
 * genuinely refuses cannot loop.
 */
export async function submitIdList<Id extends string | number>(edit: {
	/** Recompute the full list from the service's current state. */
	build: () => IdListDraft<Id>;
	send: (ids: Id[]) => Promise<MutationResult>;
	/** Refetch the state `build` reads, so rebuilding sees the server's. */
	resync: () => Promise<unknown>;
	/** Reported when even a resync leaves the state too stale to build from. */
	staleError: string;
}): Promise<MutationResult> {
	const rebuild = async () => {
		await edit.resync();
		return edit.build();
	};

	// Stale before anything was sent: sending now would mean guessing at the
	// ids the mirror couldn't name, and a guess here unlinks something nobody
	// asked to unlink. Catch up first instead.
	let ids = edit.build();
	if (ids === "stale") ids = await rebuild();
	// An intent that resolves to nothing is already satisfied — adding tracks a
	// playlist holds, unlinking an artist a track no longer names.
	if (ids === "noop") return { ok: true };
	if (ids === "stale") return { ok: false, error: edit.staleError };

	const result = await edit.send(ids);
	if (result.ok) return result;

	const rebuilt = await rebuild();
	if (rebuilt === "noop") return { ok: true };
	if (rebuilt === "stale") return { ok: false, error: edit.staleError };
	return sameIds(ids, rebuilt) ? result : await edit.send(rebuilt);
}

/**
 * Whether two id lists are the same ids in the same order. Order counts
 * because for a playlist's `trackIds` it *is* the playback order; a rebuild
 * that only reshuffled a set-like list (a track's artists) therefore costs one
 * extra send, and nothing more.
 */
function sameIds<Id extends string | number>(a: Id[], b: Id[]): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}
