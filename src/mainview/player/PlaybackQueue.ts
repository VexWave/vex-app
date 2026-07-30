import { ShuffleHistory } from "./ShuffleHistory";
import type { RepeatMode, Track } from "./types";

/**
 * Pure data structure for the play queue: ordered tracks, a current index,
 * the repeat behaviour and the shuffle history. Emits nothing —
 * PlayerController owns change notification.
 */
export class PlaybackQueue {
	private items: Track[] = [];
	private index = -1;
	private repeat: RepeatMode = "off";
	private shuffle = false;
	private history = new ShuffleHistory();

	get tracks(): readonly Track[] {
		return this.items;
	}

	get currentIndex(): number {
		return this.index;
	}

	get current(): Track | null {
		return this.items[this.index] ?? null;
	}

	get repeatMode(): RepeatMode {
		return this.repeat;
	}

	setRepeatMode(mode: RepeatMode): void {
		this.repeat = mode;
	}

	get shuffled(): boolean {
		return this.shuffle;
	}

	/**
	 * Turn shuffle on or off. Turning it on opens a round on the current track,
	 * so what is playing keeps playing and everything else is still to come.
	 */
	setShuffled(on: boolean): void {
		this.shuffle = on;
		if (on) this.restartShuffle();
	}

	/**
	 * Start shuffle over on the current track, forgetting what it played. Playing
	 * a collection does this: the history belongs to the collection it was
	 * gathered in, and says nothing about the one taking its place.
	 */
	restartShuffle(): void {
		this.history.restart(this.current);
	}

	/**
	 * Replace the whole queue with `tracks`, current index included. Unlike
	 * `add` there is no id dedupe — a playlist may legitimately contain the
	 * same track twice. An out-of-range index clamps to -1 (nothing current).
	 */
	replace(tracks: Track[], index: number): void {
		this.items = [...tracks];
		this.index =
			index >= 0 && index < this.items.length ? index : -1;
	}

	/**
	 * Remove every track matching the predicate; returns the removed tracks.
	 * The current index follows the current track when it survives, else it
	 * clamps to the item now occupying the current position.
	 */
	removeMatching(predicate: (track: Track) => boolean): Track[] {
		const removed: Track[] = [];
		const kept: Track[] = [];
		let keptBeforeCurrent = 0;
		for (const [i, track] of this.items.entries()) {
			if (predicate(track)) {
				removed.push(track);
			} else {
				kept.push(track);
				if (i < this.index) keptBeforeCurrent += 1;
			}
		}
		if (removed.length === 0) return removed;
		const current = this.current;
		this.items = kept;
		if (current) {
			this.index = predicate(current)
				? Math.min(keptBeforeCurrent, kept.length - 1)
				: keptBeforeCurrent;
		}
		return removed;
	}

	/**
	 * Jump to where playback begins: the top of the queue, or — under shuffle —
	 * the opening of a fresh round, which is any track in the queue. Restarting
	 * a queue that ran off its end and preloading a newly adopted collection
	 * both begin here.
	 */
	start(): Track | null {
		if (!this.shuffle) return this.jumpTo(0);
		this.history.restart(null);
		return this.jumpToTrack(this.history.next(this.items, false));
	}

	private jumpTo(position: number): Track | null {
		if (position < 0 || position >= this.items.length) return null;
		this.index = position;
		return this.current;
	}

	/** Put the cursor on the track shuffle drew, which is always one of `items`. */
	private jumpToTrack(track: Track | null): Track | null {
		return track ? this.jumpTo(this.items.indexOf(track)) : null;
	}

	updateTrack(id: string, patch: Partial<Track>): void {
		this.items = this.items.map((t) => (t.id === id ? { ...t, ...patch } : t));
	}

	/**
	 * Advance to the track following the cursor in the queue's own order, or to
	 * the one shuffle draws. When `wrap` is true (auto-advance after a track
	 * ends), the end only wraps around under repeat "all". Manual skips (wrap
	 * false) always wrap.
	 *
	 * Running off the end parks the cursor *before* the start rather than
	 * leaving it on the last track: nothing is current once playback stops, so
	 * -1 is the honest index — and it means the next `start` begins the queue
	 * over, the same convention `replace` and `syncCollection` already use.
	 */
	next(wrap: boolean): Track | null {
		if (this.items.length === 0) return null;
		if (this.shuffle) return this.nextShuffled(wrap);
		const atEnd = this.index >= this.items.length - 1;
		if (atEnd && wrap && this.repeat !== "all") {
			this.index = -1;
			return null;
		}
		this.index = atEnd ? 0 : this.index + 1;
		return this.current;
	}

	previous(): Track | null {
		if (this.items.length === 0) return null;
		if (this.shuffle) {
			// Back through what shuffle played, not through the queue's order:
			// the track before this one is the one that was just heard. With
			// nothing loaded — parked where a round ended — that last play is
			// itself what to come back to, the same track the queue's own order
			// wraps around to. Before the first play there is nothing to return
			// to at all.
			return this.jumpToTrack(
				this.index < 0
					? this.history.current(this.items)
					: this.history.previous(this.items),
			);
		}
		this.index = this.index <= 0 ? this.items.length - 1 : this.index - 1;
		return this.current;
	}

	/**
	 * Take the next track from the shuffle history. A round ends where the
	 * queue's own order ends — once every track has had its turn — so
	 * auto-advance stops there under repeat "off", while a skip and repeat "all"
	 * open the next round.
	 */
	private nextShuffled(wrap: boolean): Track | null {
		const track = this.history.next(
			this.items,
			wrap && this.repeat !== "all",
		);
		if (!track) {
			this.index = -1;
			return null;
		}
		return this.jumpToTrack(track);
	}
}
