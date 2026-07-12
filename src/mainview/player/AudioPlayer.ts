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

	constructor() {
		super();
		this.audio = new Audio();
		this.audio.preload = "metadata";

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
		try {
			await this.audio.play();
		} catch (err) {
			this.emit("error", err instanceof Error ? err.message : String(err));
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
