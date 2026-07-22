import { TypedEventEmitter } from "./TypedEventEmitter";
import type { Track } from "./types";

interface AudioPlayerEvents extends Record<string, unknown> {
	trackchange: Track | null;
	play: void;
	pause: void;
	timeupdate: number;
	durationchange: number;
	volumechange: { volume: number; muted: boolean };
	ended: void;
	error: string;
}

/**
 * Thin OOP wrapper around a single HTMLAudioElement. Knows nothing about
 * queues or playlists — it plays exactly one Track at a time.
 */
export class AudioPlayer extends TypedEventEmitter<AudioPlayerEvents> {
	private audio: HTMLAudioElement;
	private track: Track | null = null;
	/** Web Audio graph feeding the backdrop glow; built on the first playback. */
	private context: AudioContext | null = null;
	private analyserNode: AnalyserNode | null = null;
	/** Guards against two overlapping play() calls both building a graph. */
	private buildingGraph = false;

	constructor() {
		super();
		this.audio = new Audio();
		this.audio.preload = "metadata";
		// Must be set before any src: the stream proxy is a different origin, and
		// Web Audio refuses to expose the samples of a media element that wasn't
		// fetched CORS-clean. StreamProxy answers every request with
		// `access-control-allow-origin: *` to match.
		this.audio.crossOrigin = "anonymous";

		this.audio.addEventListener("play", () => this.emit("play", undefined));
		this.audio.addEventListener("pause", () => this.emit("pause", undefined));
		this.audio.addEventListener("ended", () => this.emit("ended", undefined));
		this.audio.addEventListener("timeupdate", () =>
			this.emit("timeupdate", this.audio.currentTime),
		);
		this.audio.addEventListener("durationchange", () => {
			if (Number.isFinite(this.audio.duration)) {
				this.emit("durationchange", this.audio.duration);
			}
		});
		this.audio.addEventListener("volumechange", () =>
			this.emit("volumechange", {
				volume: this.audio.volume,
				muted: this.audio.muted,
			}),
		);
		this.audio.addEventListener("error", () => {
			const message =
				this.audio.error?.message || "This file could not be played.";
			this.emit("error", message);
		});
	}

	get currentTrack(): Track | null {
		return this.track;
	}

	/**
	 * Live frequency analyser, or null while there is none — nothing has played
	 * yet, or the graph couldn't be built. Callers must treat it as optional:
	 * what reads it is decoration, playback is not.
	 */
	get analyser(): AnalyserNode | null {
		return this.analyserNode;
	}

	get currentTime(): number {
		return this.audio.currentTime;
	}

	get duration(): number {
		return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
	}

	get isPlaying(): boolean {
		return !this.audio.paused && !this.audio.ended;
	}

	get volume(): number {
		return this.audio.volume;
	}

	get muted(): boolean {
		return this.audio.muted;
	}

	/** Load a track (or unload with null). Does not autoplay. */
	load(track: Track | null): void {
		this.track = track;
		if (track) {
			this.audio.src = track.src;
		} else {
			this.audio.removeAttribute("src");
			this.audio.load();
		}
		this.emit("trackchange", track);
	}

	async play(): Promise<void> {
		if (!this.track) return;
		// Not awaited: this is called from a click, and the element should start
		// on that gesture rather than behind an AudioContext round-trip.
		void this.ensureAnalyser();
		try {
			await this.audio.play();
		} catch (err) {
			this.emit("error", err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Builds the analyser graph once, on the first playback.
	 *
	 * The order here is deliberate, because the failure mode is severe:
	 * createMediaElementSource captures the element's output *permanently*, so
	 * a context that is merely suspended — no user gesture yet — swallows the
	 * audio with no way to hand it back. Hence the element is only captured
	 * once the context is confirmed running, and if anything later in the setup
	 * throws, the source is wired straight to the destination so sound survives
	 * without an analyser.
	 */
	private async ensureAnalyser(): Promise<void> {
		if (this.context) {
			// A live context can be suspended again later (system sleep); the
			// element already routes through it, so it has to come back.
			if (this.context.state === "suspended") {
				await this.context.resume().catch(() => {});
			}
			return;
		}

		// Double-clicking a track fires play() twice; without this both calls
		// reach createMediaElementSource, and the element can only ever be
		// captured once — the loser throws and burns a context.
		if (this.buildingGraph) return;
		this.buildingGraph = true;

		let context: AudioContext | null = null;
		let source: MediaElementAudioSourceNode | null = null;
		try {
			context = new AudioContext();
			await context.resume();
			// Retried on the next play() — a later gesture may well succeed.
			if (context.state !== "running") {
				void context.close().catch(() => {});
				return;
			}
			source = context.createMediaElementSource(this.audio);
			const analyser = context.createAnalyser();
			// 2048 is a ~43ms window: fine enough to place a kick, short enough
			// not to smear it. Barely any smoothing, because the consumer is an
			// envelope follower that does its own — the analyser's would only
			// round off the transients before it ever sees them.
			analyser.fftSize = 2048;
			analyser.smoothingTimeConstant = 0.2;
			source.connect(analyser);
			analyser.connect(context.destination);
			// Last line of defence for the silent-playback case above.
			context.addEventListener("statechange", () => {
				if (this.context?.state === "suspended") {
					void this.context.resume().catch(() => {});
				}
			});
			this.context = context;
			this.analyserNode = analyser;
		} catch {
			this.analyserNode = null;
			if (source && context) {
				// The element is captured for good; wire it straight to the
				// output and keep the context, which now has to stay alive.
				try {
					source.disconnect();
					source.connect(context.destination);
					this.context = context;
				} catch {
					// Nothing further to try — playback may be silent, and
					// closing the context wouldn't give the element back.
				}
			} else {
				void context?.close().catch(() => {});
			}
		} finally {
			this.buildingGraph = false;
		}
	}

	pause(): void {
		this.audio.pause();
	}

	async toggle(): Promise<void> {
		if (this.isPlaying) {
			this.pause();
		} else {
			await this.play();
		}
	}

	seek(seconds: number): void {
		if (!this.track) return;
		const max = this.duration || seconds;
		this.audio.currentTime = Math.min(Math.max(seconds, 0), max);
	}

	setVolume(volume: number): void {
		this.audio.volume = Math.min(Math.max(volume, 0), 1);
	}

	setMuted(muted: boolean): void {
		this.audio.muted = muted;
	}
}
