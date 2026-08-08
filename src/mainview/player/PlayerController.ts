import { storage } from "@/lib/storage";
import { AudioPlayer } from "./AudioPlayer";
import { PlaybackQueue } from "./PlaybackQueue";
import type { Effects } from "./Effects";
import type { Equalizer } from "./Equalizer";
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

		// Subscribed after restoreSettings, which lands as one commit: earlier and
		// the settings just read would be written straight back out.
		this.player.equalizer.subscribe(() => this.persistEqualizer());
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

	/**
	 * The equalizer sitting in the playback graph. A store of its own rather than
	 * part of the state snapshot: the settings view is the only thing that reads
	 * it, and folding ten faders into the snapshot every view already subscribes
	 * to would re-render the whole app on each drag frame.
	 */
	get equalizer(): Equalizer {
		return this.player.equalizer;
	}

	/**
	 * Playback speed and reverb, a store of its own for the same reason the
	 * equalizer is one — and more sharply, since these sit in the player bar: a
	 * slider dragged there would otherwise churn the snapshot every view
	 * subscribes to, re-rendering every track row in the app on each drag frame.
	 */
	get effects(): Effects {
		return this.player.effects;
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
	 * `index`, or wherever the queue begins when no track is named. This is what
	 * playing from the library, from a playlist and from an artist all do — the
	 * queue becomes that collection, in its order.
	 */
	playCollection(contextId: string, tracks: Track[], index = -1): void {
		this.queueContext = contextId;
		this.queue.replace(tracks, index);
		this.queue.restartShuffle();
		this.startCurrent();
	}

	/**
	 * What every collection-level play button does (grid card, detail header,
	 * sidebar row): if the collection already owns the queue, toggle
	 * pause/resume in place; otherwise replace the queue with it and start
	 * playing. It lives here rather than in each service so that playing a
	 * playlist, an artist or the library all mean the same thing.
	 *
	 * The press names no track — it asks for the collection, where clicking a
	 * row asks for a track — so it opens at the queue's top, or anywhere in it
	 * under shuffle.
	 */
	playOrToggleCollection(contextId: string, tracks: Track[]): void {
		if (this.queueContext === contextId) {
			this.togglePlay();
			return;
		}
		this.playCollection(contextId, tracks);
	}

	/**
	 * Mirror a collection's latest content into the queue. Applies only when the
	 * queue already belongs to `contextId` — or to nothing yet (fresh login),
	 * which adopts the collection and preloads its first track paused.
	 *
	 * A track that leaves the collection while it is the one playing (removed
	 * from the playlist, unlinked from the artist) takes playback with it: the
	 * queue is what the transport addresses, so a track playing from outside it
	 * would keep going with nothing able to pause or follow it — and once the
	 * collection is emptied entirely, with a transport that has no queue left to
	 * enable. It stops where a queue that ran off its end stops instead.
	 */
	syncCollection(contextId: string, tracks: Track[]): void {
		if (this.queueContext !== null && this.queueContext !== contextId) return;
		this.queueContext = contextId;
		const current = this.player.currentTrack;
		const index = current
			? tracks.findIndex((track) => track.id === current.id)
			: -1;
		this.queue.replace(tracks, index);
		if (current && index === -1) {
			// Same state as the end of a queue under repeat "off": nothing
			// loaded, whatever is left still queued, so play starts it over.
			this.player.load(null);
		} else if (!current && tracks.length > 0) {
			// Nothing loaded yet — preload where playback would begin so the UI
			// shows it, but leave starting it to the user.
			this.player.load(this.queue.start());
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

	/**
	 * Play/pause, and the one place that restarts a finished queue. Nothing
	 * loaded while tracks are still queued means playback ran off the end under
	 * repeat "off" — there is no track to resume, so the press starts the
	 * collection over, from its top or on a fresh shuffle round. Every play
	 * button in the app funnels through here (the transport directly, the
	 * collection ones via `playOrToggleCollection`), so it is the one place
	 * that has to know.
	 */
	togglePlay(): void {
		if (!this.player.currentTrack && this.queue.tracks.length > 0) {
			this.queue.start();
			this.startCurrent();
			return;
		}
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

	/**
	 * Switch shuffle on or off. It decides what follows the current track, so
	 * the track playing is unaffected either way — turning it on opens a round on
	 * that track, turning it off returns the queue to its own order from there.
	 */
	toggleShuffle(): void {
		this.queue.setShuffled(!this.queue.shuffled);
		this.persistSettings();
		this.refresh();
	}

	// --- internals ---

	/**
	 * Load whatever the queue's cursor points at and start it, clearing any
	 * error left by the previous track. A cursor on nothing means no track was
	 * named, so playback begins where the queue itself begins — and on an empty
	 * queue there is nothing there either, which just unloads. Shared by
	 * `playCollection` and the end-of-queue restart so both begin identically.
	 */
	private startCurrent(): void {
		const track = this.queue.current ?? this.queue.start();
		this.player.load(track);
		if (track) {
			this.error = null;
			void this.player.play();
		}
		this.refresh();
	}

	/**
	 * Load persisted volume/mute/repeat/shuffle and the equalizer from
	 * localStorage into the player and queue. Runs before the first snapshot so
	 * the UI opens on the last-used settings. Malformed or missing values fall
	 * back to the constructor defaults.
	 */
	private restoreSettings(): void {
		const volume = storage.player.volume.get();
		if (volume !== null) this.player.setVolume(volume);
		if (storage.player.muted.get()) this.player.setMuted(true);
		const repeat = storage.player.repeat.get();
		if (repeat !== null) this.queue.setRepeatMode(repeat);
		if (storage.player.shuffle.get()) this.queue.setShuffled(true);

		this.player.equalizer.restore({
			enabled: storage.equalizer.enabled.get(),
			gains: storage.equalizer.gains.get(),
			preampDb: storage.equalizer.preamp.get(),
		});
	}

	/** Persist the current volume/mute/repeat/shuffle so they survive a restart. */
	private persistSettings(): void {
		storage.player.volume.set(this.player.volume);
		storage.player.muted.set(this.player.muted);
		storage.player.repeat.set(this.queue.repeatMode);
		storage.player.shuffle.set(this.queue.shuffled);
	}

	/**
	 * Persist the equalizer, on every change it reports — the faders are its own
	 * control surface, so unlike volume or repeat there is no method here to hang
	 * this off.
	 */
	private persistEqualizer(): void {
		const { enabled, gains, preampDb } = this.player.equalizer.getSnapshot();
		storage.equalizer.enabled.set(enabled);
		storage.equalizer.gains.set(gains);
		storage.equalizer.preamp.set(preampDb);
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
			shuffled: this.queue.shuffled,
			error: this.error,
		};
	}

	private refresh(): void {
		this.snapshot = this.buildSnapshot();
		this.subscribers.forEach((notify) => notify());
	}
}
