import type { Track } from "./types";

/**
 * What shuffle plays next, and what it has already played.
 *
 * Two rules pick the next track. It comes from those that have not played in
 * the round under way, so none comes round a second time while another still
 * waits for its first; and among those, anything heard within the last half
 * queue of plays is passed over.
 *
 * The second rule is what carries across the moment a round completes. Rounds
 * drawn independently of one another are free to open on the track that just
 * closed the previous one, and on the handful before it — those run twice
 * within a few plays while the tracks that opened the previous round wait out
 * nearly two rounds, which is the opposite of what a listener asked shuffle
 * for. Only the round's own memory resets at that boundary; how recently
 * something was heard doesn't.
 *
 * What it remembers are track ids, never queue positions: the queue is replaced
 * wholesale whenever the collection it mirrors is refetched — an upload
 * landing, an import finishing, a track edited — which renumbers every position
 * while leaving the ids alone, so a refresh mid-round costs the round nothing.
 */
export class ShuffleHistory {
	/** Ids in the order they were played, oldest first. */
	private played: string[] = [];
	/** The ids that have had their turn in the round under way. */
	private thisRound = new Set<string>();
	/** How many plays back `previous` has walked; 0 while at the newest play. */
	private back = 0;

	/**
	 * Start over, counting `playing` as the round's first play so that what is
	 * already on air isn't drawn again straight after itself.
	 */
	restart(playing: Track | null): void {
		this.played = [];
		this.thisRound.clear();
		this.back = 0;
		if (playing) this.record(playing.id);
	}

	/**
	 * The next track to play: the one the cursor steps forward onto when
	 * `previous` walked back from the newest play, and a fresh draw once it is
	 * back there. Stepping forward replays history rather than extending it, so
	 * walking back and forward again costs no track its turn.
	 *
	 * `stopAtRoundEnd` asks for null instead of a new round once every track has
	 * had its turn. History still comes first: a listener who walked back is
	 * played forward to where they left off before the round is called finished.
	 */
	next(items: readonly Track[], stopAtRoundEnd: boolean): Track | null {
		if (items.length === 0) return null;
		const replayed = this.stepForward(items);
		if (replayed) return replayed;
		if (stopAtRoundEnd && this.roundComplete(items)) return null;
		const drawn = this.draw(items);
		this.record(drawn.id);
		return drawn;
	}

	/**
	 * The play the cursor sits on, if the queue still holds it. What Previous
	 * answers with while nothing is loaded: the round ended there, so that play
	 * is the one still to come back to rather than one to step over.
	 */
	current(items: readonly Track[]): Track | null {
		return this.at(items, this.back);
	}

	/**
	 * The play before the cursor — skipping any track the queue has since lost —
	 * or null at the start of the history, where there is nothing earlier to
	 * return to.
	 */
	previous(items: readonly Track[]): Track | null {
		for (let back = this.back + 1; back < this.played.length; back++) {
			const track = this.at(items, back);
			if (track) {
				this.back = back;
				return track;
			}
		}
		return null;
	}

	/**
	 * Draw from the tracks still due this round, minus those heard within the
	 * last half queue of plays.
	 *
	 * Half the queue is the widest gap worth insisting on: every track held back
	 * is one the draw cannot choose, and holding back much more than half leaves
	 * so few candidates that every round comes out in nearly the same order.
	 * Should the recent plays cover everything due — which takes a queue of too
	 * few distinct tracks to space anything out, one holding the same track
	 * twice over — spacing gives way rather than the round, which still gives
	 * every track its turn.
	 */
	private draw(items: readonly Track[]): Track {
		if (this.roundComplete(items)) this.thisRound.clear();
		const due = items.filter((track) => !this.thisRound.has(track.id));
		const gap = Math.floor(items.length / 2);
		const recent = new Set(this.played.slice(this.played.length - gap));
		const spaced = due.filter((track) => !recent.has(track.id));
		const pool = spaced.length > 0 ? spaced : due;
		return pool[Math.floor(Math.random() * pool.length)];
	}

	/** Whether every track in `items` has had its turn in this round. */
	private roundComplete(items: readonly Track[]): boolean {
		return items.every((track) => this.thisRound.has(track.id));
	}

	/** The track `back` plays before the newest one, if the queue still holds it. */
	private at(items: readonly Track[], back: number): Track | null {
		const id = this.played[this.played.length - 1 - back];
		return items.find((track) => track.id === id) ?? null;
	}

	private stepForward(items: readonly Track[]): Track | null {
		while (this.back > 0) {
			this.back -= 1;
			const track = this.at(items, this.back);
			if (track) return track;
		}
		return null;
	}

	private record(id: string): void {
		this.played.push(id);
		this.thisRound.add(id);
	}
}
