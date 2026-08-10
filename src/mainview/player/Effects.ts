import { clamp } from "@/lib/utils";
import type { GraphStage } from "./audioGraph";
import { Drive } from "./Drive";
import { Reverb } from "./Reverb";

/**
 * How far the speed may be pushed, as a multiple of the recording's own. The
 * element runs well outside this — the range is as far either way as a track
 * stays recognisable as itself, and the same distance either way so that
 * untouched sits at the middle of the slider's travel.
 */
export const RATE_MIN = 0.5;
export const RATE_MAX = 1.5;
/**
 * Resolution of the speed slider. Radix rounds every value it produces to the
 * step's decimal count, so 1 arrives as exactly 1 — which is what `reset` and the
 * panel's engaged/idle treatment compare against.
 */
export const RATE_STEP = 0.05;

export interface EffectsState {
	/** A multiple of the recording's own speed; 1 is untouched. */
	rate: number;
	/** Off is the tape effect, where slowing down also drops the key. */
	preservePitch: boolean;
	/** 0 is an exact bypass, 1 the peaks flattened — see `Drive`. */
	drive: number;
	/** 0 is an exact bypass, 1 a hall at the fullest send — see `Reverb`. */
	reverbMix: number;
}

/**
 * Playback speed, drive and reverb: the store the effects panel reads, and the
 * `GraphStage` that chains the two wet stages together.
 *
 * A store of its own, so dragging a slider re-renders the panel and leaves every
 * track row in the app where it was.
 *
 * Speed is a property of the element, which puts it *upstream* of
 * `createMediaElementSource` — the equalizer, the analyser and the backdrop glow
 * all follow a speed change without knowing about it. Volume is upstream for the
 * same reason, which is the problem `Drive` exists to undo.
 */
export class Effects implements GraphStage {
	private subscribers = new Set<() => void>();
	private rate = 1;
	private preservePitch = false;
	private readonly drive: Drive;
	private readonly reverb = new Reverb();
	private snapshot: EffectsState;

	constructor(private readonly audio: HTMLAudioElement) {
		this.drive = new Drive(audio);
		this.snapshot = this.buildSnapshot();
		// So the element is in a known state without waiting for a first change.
		this.applyRate();
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): EffectsState => this.snapshot;

	// --- settings ---

	setRate(rate: number): void {
		const next = clamp(rate, RATE_MIN, RATE_MAX, 1);
		if (next === this.rate) return;
		this.rate = next;
		this.applyRate();
		this.commit();
	}

	setPreservePitch(preservePitch: boolean): void {
		if (preservePitch === this.preservePitch) return;
		this.preservePitch = preservePitch;
		this.applyRate();
		this.commit();
	}

	setDrive(drive: number): void {
		if (this.drive.set(drive)) this.commit();
	}

	setReverbMix(mix: number): void {
		if (this.reverb.set(mix)) this.commit();
	}

	/**
	 * Back to the recording as it was made. One commit, so a subscriber always
	 * sees the three reset together.
	 *
	 * `preservePitch` stands, as the equalizer's switch does through its own reset
	 * — it is a mode, and reset returns values.
	 */
	reset(): void {
		const speed = this.rate !== 1;
		if (speed) {
			this.rate = 1;
			this.applyRate();
		}
		const drive = this.drive.set(0);
		const reverb = this.reverb.set(0);
		if (speed || drive || reverb) this.commit();
	}

	// --- the audio graph ---

	/**
	 * Drive before reverb, so the room hears the track as it is meant to sound
	 * rather than a clean track distorted along with its own reflections.
	 */
	attach(context: AudioContext, input: AudioNode): AudioNode {
		return this.reverb.attach(context, this.drive.attach(context, input));
	}

	release(): void {
		this.drive.release();
		this.reverb.release();
	}

	// --- internals ---

	/**
	 * **Both properties are written, and `defaultPlaybackRate` is the load-bearing
	 * one.** Assigning a src runs the media element load algorithm, whose step 8
	 * sets `playbackRate` from `defaultPlaybackRate` — so writing it here is the
	 * whole of why a track change carries the speed over.
	 */
	private applyRate(): void {
		this.audio.defaultPlaybackRate = this.rate;
		this.audio.playbackRate = this.rate;
		this.audio.preservesPitch = this.preservePitch;
	}

	private commit(): void {
		this.snapshot = this.buildSnapshot();
		this.subscribers.forEach((notify) => notify());
	}

	private buildSnapshot(): EffectsState {
		return {
			rate: this.rate,
			preservePitch: this.preservePitch,
			drive: this.drive.value,
			reverbMix: this.reverb.value,
		};
	}
}
