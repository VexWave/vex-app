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

	add(tracks: Track[]): void {
		this.items = [...this.items, ...tracks];
	}

	/** Remove a track; returns it so the caller can release its resources. */
	removeAt(position: number): Track | null {
		const removed = this.items[position];
		if (!removed) return null;
		this.items = this.items.filter((_, i) => i !== position);
		if (position < this.index) {
			this.index -= 1;
		} else if (position === this.index) {
			// Current track was removed; clamp to the item now at this position.
			this.index = Math.min(this.index, this.items.length - 1);
		}
		return removed;
	}

	/** Empty the queue; returns the removed tracks for cleanup. */
	clear(): Track[] {
		const removed = this.items;
		this.items = [];
		this.index = -1;
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
	 */
	next(wrap: boolean): Track | null {
		if (this.items.length === 0) return null;
		const atEnd = this.index >= this.items.length - 1;
		if (atEnd && wrap && this.repeat !== "all") return null;
		this.index = atEnd ? 0 : this.index + 1;
		return this.current;
	}

	previous(): Track | null {
		if (this.items.length === 0) return null;
		this.index = this.index <= 0 ? this.items.length - 1 : this.index - 1;
		return this.current;
	}
}
