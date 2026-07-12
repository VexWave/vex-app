import { AudioPlayer } from "./AudioPlayer";
import { LocalTrackLoader } from "./LocalTrackLoader";
import { PlaybackQueue } from "./PlaybackQueue";
import type { PlayerState, RepeatMode, Track } from "./types";

const REPEAT_CYCLE: RepeatMode[] = ["off", "all", "one"];

/**
 * Facade the UI talks to. Owns the AudioPlayer and the PlaybackQueue,
 * auto-advances when a track ends and exposes a single immutable state
 * snapshot compatible with React's useSyncExternalStore.
 */
export class PlayerController {
	private player = new AudioPlayer();
	private queue = new PlaybackQueue();
	private subscribers = new Set<() => void>();
	private error: string | null = null;
	private snapshot: PlayerState;

	constructor() {
		this.snapshot = this.buildSnapshot();

		this.player.on("play", () => this.refresh());
		this.player.on("pause", () => this.refresh());
		this.player.on("timeupdate", () => this.refresh());
		this.player.on("volumechange", () => this.refresh());
		this.player.on("trackchange", () => this.refresh());

		this.player.on("durationchange", (duration) => {
			// Backfill duration for tracks whose metadata didn't include it.
			const current = this.player.currentTrack;
			if (current && current.durationSec === 0 && duration > 0) {
				this.queue.updateTrack(current.id, { durationSec: duration });
			}
			this.refresh();
		});

		this.player.on("ended", () => {
			if (this.queue.repeatMode === "one") {
				this.player.seek(0);
				void this.player.play();
				return;
			}
			const next = this.queue.next(true);
			this.player.load(next);
			if (next) void this.player.play();
			this.refresh();
		});

		this.player.on("error", (message) => {
			this.error = message;
			this.refresh();
		});
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): PlayerState => this.snapshot;

	// --- queue management ---

	addTracks(tracks: Track[]): void {
		if (tracks.length === 0) return;
		const wasEmpty = this.queue.tracks.length === 0;
		this.queue.add(tracks);
		// Preload the first track into the player so the UI shows it,
		// but leave starting playback to the user.
		if (wasEmpty) {
			this.player.load(this.queue.jumpTo(0));
		}
		this.refresh();
	}

	removeTrack(position: number): void {
		const isCurrent = position === this.queue.currentIndex;
		const wasPlaying = this.player.isPlaying;
		const removed = this.queue.removeAt(position);
		if (!removed) return;
		if (isCurrent) {
			const replacement = this.queue.current;
			this.player.load(replacement);
			if (replacement && wasPlaying) void this.player.play();
		}
		LocalTrackLoader.dispose(removed);
		this.refresh();
	}

	clearQueue(): void {
		this.player.load(null);
		for (const track of this.queue.clear()) {
			LocalTrackLoader.dispose(track);
		}
		this.refresh();
	}

	// --- transport ---

	playTrackAt(position: number): void {
		const track = this.queue.jumpTo(position);
		if (!track) return;
		this.error = null;
		this.player.load(track);
		void this.player.play();
		this.refresh();
	}

	togglePlay(): void {
		void this.player.toggle();
	}

	next(): void {
		const track = this.queue.next(false);
		if (!track) return;
		const wasPlaying = this.player.isPlaying;
		this.player.load(track);
		if (wasPlaying) void this.player.play();
		this.refresh();
	}

	previous(): void {
		// Standard player behaviour: restart the track unless we're right
		// at its beginning.
		if (this.player.currentTime > 3) {
			this.player.seek(0);
			return;
		}
		const track = this.queue.previous();
		if (!track) return;
		const wasPlaying = this.player.isPlaying;
		this.player.load(track);
		if (wasPlaying) void this.player.play();
		this.refresh();
	}

	seek(seconds: number): void {
		this.player.seek(seconds);
	}

	setVolume(volume: number): void {
		this.player.setVolume(volume);
		if (volume > 0) this.player.setMuted(false);
	}

	toggleMute(): void {
		this.player.setMuted(!this.player.muted);
	}

	cycleRepeatMode(): void {
		const current = REPEAT_CYCLE.indexOf(this.queue.repeatMode);
		this.queue.setRepeatMode(
			REPEAT_CYCLE[(current + 1) % REPEAT_CYCLE.length],
		);
		this.refresh();
	}

	// --- internals ---

	private buildSnapshot(): PlayerState {
		const current = this.player.currentTrack;
		return {
			tracks: this.queue.tracks,
			currentTrack: current,
			currentIndex: this.queue.currentIndex,
			isPlaying: this.player.isPlaying,
			currentTimeSec: this.player.currentTime,
			durationSec: this.player.duration || current?.durationSec || 0,
			volume: this.player.volume,
			muted: this.player.muted,
			repeatMode: this.queue.repeatMode,
			error: this.error,
		};
	}

	private refresh(): void {
		this.snapshot = this.buildSnapshot();
		this.subscribers.forEach((notify) => notify());
	}
}
