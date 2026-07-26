import type { RepeatMode, Track } from "./types";

/**
 * Pure data structure for the play queue: ordered tracks, a current index
 * and the repeat behaviour. Emits nothing — PlayerController owns change
 * notification.
 */
export class PlaybackQueue {
	private items: Track[] = [];
	private index = -1;
	private repeat: RepeatMode = "off";

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

	jumpTo(position: number): Track | null {
		if (position < 0 || position >= this.items.length) return null;
		this.index = position;
		return this.current;
	}

	updateTrack(id: string, patch: Partial<Track>): void {
		this.items = this.items.map((t) => (t.id === id ? { ...t, ...patch } : t));
	}

	/**
	 * Advance to the next track. When `wrap` is true (auto-advance after a
	 * track ends), the end of the queue only wraps around under repeat "all".
	 * Manual skips (wrap false) always wrap.
	 *
	 * Running off the end parks the cursor *before* the start rather than
	 * leaving it on the last track: nothing is current once playback stops, so
	 * -1 is the honest index — and it means the next start resumes at the top,
	 * the same convention `replace` and `syncCollection` already use.
	 */
	next(wrap: boolean): Track | null {
		if (this.items.length === 0) return null;
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
		this.index = this.index <= 0 ? this.items.length - 1 : this.index - 1;
		return this.current;
	}
}
