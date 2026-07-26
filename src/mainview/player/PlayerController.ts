import { storage } from "@/lib/storage";
import { AudioPlayer } from "./AudioPlayer";
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
	private queueContext: string | null = null;
	private subscribers = new Set<() => void>();
	private error: string | null = null;
	private snapshot: PlayerState;

	constructor() {
		this.restoreSettings();
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

	/**
	 * Live frequency analyser for the backdrop glow, or null until playback has
	 * started. Deliberately not part of the state snapshot — it's a mutable
	 * audio node read per animation frame, not something React should diff.
	 */
	get analyser(): AnalyserNode | null {
		return this.player.analyser;
	}

	// --- queue management ---

	/**
	 * The collection the queue currently mirrors ("library", "playlist-3", …),
	 * or null while nothing has been queued yet. Services use it to decide
	 * whether their refreshes should be synced into the queue.
	 */
	get queueContextId(): string | null {
		return this.queueContext;
	}

	/**
	 * Replace the queue with a collection and start playing the track at
	 * `index`. This is what "playing from the library" and "playing a
	 * playlist" both do — the queue becomes that collection, in its order.
	 */
	playCollection(contextId: string, tracks: Track[], index: number): void {
		this.queueContext = contextId;
		this.queue.replace(tracks, index);
		const track = this.queue.current;
		this.player.load(track);
		if (track) {
			this.error = null;
			void this.player.play();
		}
		this.refresh();
	}

	/**
	 * Mirror a collection's latest content into the queue without touching
	 * playback. Applies only when the queue already belongs to `contextId` —
	 * or to nothing yet (fresh login), which adopts the collection and
	 * preloads its first track paused. The playing track keeps playing even
	 * when it fell out of the collection; the index just drops to -1 so
	 * auto-advance restarts from the top.
	 */
	syncCollection(contextId: string, tracks: Track[]): void {
		if (this.queueContext !== null && this.queueContext !== contextId) return;
		this.queueContext = contextId;
		const current = this.player.currentTrack;
		this.queue.replace(
			tracks,
			current ? tracks.findIndex((track) => track.id === current.id) : -1,
		);
		if (!current && tracks.length > 0) {
			// Nothing loaded yet — preload the first track so the UI shows it,
			// but leave starting playback to the user.
			this.player.load(this.queue.jumpTo(0));
		}
		this.refresh();
	}

	/** Empty the queue and unload the player (logout — streams die with the session). */
	clearQueue(): void {
		this.queueContext = null;
		this.queue.replace([], -1);
		this.player.load(null);
		this.refresh();
	}

	/**
	 * Patch a queued track's metadata (e.g. after its artists were edited on
	 * the server). Patches every queued copy; no-op when the id isn't queued.
	 */
	updateTrack(id: string, patch: Partial<Track>): void {
		this.queue.updateTrack(id, patch);
		this.refresh();
	}

	/** Remove every track matching the predicate (e.g. one deleted server-side). */
	removeTracks(predicate: (track: Track) => boolean): void {
		const current = this.queue.current;
		const removed = this.queue.removeMatching(predicate);
		if (removed.length === 0) return;
		if (current && removed.includes(current)) {
			// Deleting the track that's playing stops playback rather than
			// auto-advancing — the replacement is loaded (so the UI shows it)
			// but left paused.
			this.player.load(this.queue.current);
		}
		this.refresh();
	}

	// --- transport ---

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
		this.persistSettings();
	}

	toggleMute(): void {
		this.player.setMuted(!this.player.muted);
		this.persistSettings();
	}

	cycleRepeatMode(): void {
		const current = REPEAT_CYCLE.indexOf(this.queue.repeatMode);
		this.queue.setRepeatMode(
			REPEAT_CYCLE[(current + 1) % REPEAT_CYCLE.length],
		);
		this.persistSettings();
		this.refresh();
	}

	// --- internals ---

	/**
	 * Load persisted volume/mute/repeat from localStorage into the player and
	 * queue. Runs before the first snapshot so the UI opens on the last-used
	 * settings. Malformed or missing values fall back to the constructor defaults.
	 */
	private restoreSettings(): void {
		const volume = storage.player.volume.get();
		if (volume !== null) this.player.setVolume(volume);
		if (storage.player.muted.get()) this.player.setMuted(true);
		const repeat = storage.player.repeat.get();
		if (repeat !== null) this.queue.setRepeatMode(repeat);
	}

	/** Persist the current volume/mute/repeat so they survive a restart. */
	private persistSettings(): void {
		storage.player.volume.set(this.player.volume);
		storage.player.muted.set(this.player.muted);
		storage.player.repeat.set(this.queue.repeatMode);
	}

	private buildSnapshot(): PlayerState {
		const current = this.player.currentTrack;
		return {
			queueContextId: this.queueContext,
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
