import { clamp } from "@/lib/utils";
import { easeParam, type GraphStage } from "./audioGraph";

/**
 * How far the speed may be pushed, as a multiple of the recording's own. The
 * element runs well outside this — the range is as far either way as a track
 * stays recognisable as itself, and it is the same distance either way so that
 * untouched sits at the middle of the slider's travel.
 */
export const RATE_MIN = 0.5;
export const RATE_MAX = 1.5;
/**
 * Resolution of the speed slider — what one arrow key moves, and what puts 1×
 * exactly on the grid. Radix rounds every value it produces to the step's
 * decimal count, so 1 arrives as exactly 1, which is what `reset` and the
 * panel's engaged/idle treatment compare against.
 */
export const RATE_STEP = 0.05;

/** Length of the reverb's tail, in seconds. */
const DECAY_SEC = 2.4;
/** Silence before the first reflection — how far away the walls are. */
const PRE_DELAY_SEC = 0.022;
/**
 * How far the tail's lowpass closes by the end, from 1 (as bright as it started)
 * down towards 0.
 */
const DAMPING = 0.18;

export interface EffectsState {
	/** Playback speed as a multiple of the recording's own; 1 is untouched. */
	rate: number;
	/**
	 * Whether the pitch is held while the speed changes. Off is the tape effect,
	 * where slowing down also drops the key; on is the time-stretch a browser
	 * does by default.
	 */
	preservePitch: boolean;
	/** 0 fully dry, 1 fully wet. */
	reverbMix: number;
}

/**
 * The reverb's impulse response, made rather than fetched: noise under a decay
 * envelope is what a diffuse tail *is*, so one pass over a buffer costs less
 * than a file, a request and a decode would.
 *
 * Three things separate this from plain shaped noise, and each is what makes the
 * result read as a room rather than as a burst of static:
 *
 *  - Each channel gets its own noise. A two-channel response convolves left with
 *    left and right with right, so independent noise is what spreads the tail
 *    across the image instead of piling it up in the middle.
 *  - The head of the buffer is left silent, so the dry transient is heard before
 *    the room answers it. Baked into the buffer rather than given a DelayNode,
 *    because how late the first reflection arrives *is* how big the room is.
 *  - A one-pole lowpass whose cutoff closes as the tail decays, because air and
 *    soft surfaces take the top off a reflection long before they take its body.
 *    Without it the tail stays as bright as the noise it came from, which is the
 *    metallic ring of every naive convolution reverb.
 */
function buildImpulse(context: BaseAudioContext): AudioBuffer {
	const head = Math.floor(PRE_DELAY_SEC * context.sampleRate);
	const tail = Math.floor(DECAY_SEC * context.sampleRate);
	const buffer = context.createBuffer(2, head + tail, context.sampleRate);

	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const samples = buffer.getChannelData(channel);
		let filtered = 0;
		for (let i = 0; i < tail; i++) {
			// 0 at the first reflection, 1 at the end of the tail.
			const t = i / tail;
			const coefficient = DAMPING + (1 - DAMPING) * (1 - t);
			filtered += coefficient * (Math.random() * 2 - 1 - filtered);
			// A power curve rather than an exponential, because it reaches exactly
			// zero at the end: an exponential truncated at the last sample is still
			// audible there, and a response that stops mid-level is a click.
			samples[head + i] = filtered * (1 - t) ** 2.2;
		}
	}
	return buffer;
}

/**
 * Playback speed and reverb, and the settings that describe them.
 *
 * The same shape as `Equalizer`: it holds the settings whether or not there is a
 * graph to apply them to, `attach` marries the two once `AudioPlayer` builds the
 * graph on the first playback, and it is a store of its own rather than part of
 * the player's snapshot so that dragging a slider doesn't re-render every track
 * row in the app.
 *
 * Unlike the equalizer it also owns a piece of the element, because speed is an
 * element property rather than an audio node. That places it *upstream* of
 * `createMediaElementSource`, which is why the equalizer, the analyser and the
 * backdrop glow all follow a speed change without knowing about it.
 */
export class Effects implements GraphStage {
	private subscribers = new Set<() => void>();
	private rate = 1;
	private preservePitch = false;
	private reverbMix = 0;
	private snapshot: EffectsState;

	/** Null until the playback graph is built; the settings stand without it. */
	private context: AudioContext | null = null;
	private convolver: ConvolverNode | null = null;
	private dryGain: GainNode | null = null;
	private wetGain: GainNode | null = null;
	/** Built the first time the reverb is audible, and kept for the session. */
	private impulse: AudioBuffer | null = null;

	constructor(private readonly audio: HTMLAudioElement) {
		this.snapshot = this.buildSnapshot();
		// The element carries the defaults from the start, so nothing has to wait
		// for a first change to put it in a known state.
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
		this.commit();
	}

	/**
	 * Back to the recording as it was made: its own speed, and no room. One
	 * commit rather than two setters, so the pair cannot be caught half reset or
	 * handed to storage as two changes.
	 *
	 * `preservePitch` stands, the way the equalizer's switch does through its own
	 * reset: it says how the speed control behaves, not how far it was pushed.
	 */
	reset(): void {
		if (this.rate === 1 && this.reverbMix === 0) return;
		this.rate = 1;
		this.reverbMix = 0;
		this.commit();
	}

	setPreservePitch(preservePitch: boolean): void {
		if (preservePitch === this.preservePitch) return;
		this.preservePitch = preservePitch;
		this.commit();
	}

	setReverbMix(mix: number): void {
		const next = clamp(mix, 0, 1, 0);
		if (next === this.reverbMix) return;
		this.reverbMix = next;
		this.commit();
	}

	/**
	 * Put stored settings back, as one commit rather than one per field: a
	 * subscriber cannot catch the restore half applied, and cannot hand it back
	 * to storage as three separate changes either. A null field is a key that was
	 * never written or failed validation, and leaves the default standing.
	 */
	restore(stored: {
		rate: number | null;
		preservePitch: boolean | null;
		reverbMix: number | null;
	}): void {
		if (stored.rate !== null) {
			this.rate = clamp(stored.rate, RATE_MIN, RATE_MAX, 1);
		}
		if (stored.preservePitch !== null) this.preservePitch = stored.preservePitch;
		if (stored.reverbMix !== null) {
			this.reverbMix = clamp(stored.reverbMix, 0, 1, 0);
		}
		this.commit();
	}

	// --- the audio graph ---

	/**
	 * Build the wet/dry split and hang it off `input`, per `GraphStage`:
	 *
	 *     input ─┬─────────────────► dry ─┬─► mix
	 *            └─► convolver ─► wet ────┘
	 *
	 * The convolver comes up with no buffer, and so with no convolution to do: the
	 * response is built on the first change that makes it audible, so a session
	 * that never touches the reverb never pays for one. What an empty convolver
	 * *emits* is the implementation's business rather than the spec's, and the wet
	 * gain sitting at zero until the mix is raised is what makes that moot.
	 */
	attach(context: AudioContext, input: AudioNode): AudioNode {
		this.context = context;
		const mix = context.createGain();
		this.dryGain = context.createGain();
		this.wetGain = context.createGain();
		// Born at their values rather than eased into them. A GainNode comes up at
		// 1, which on the wet branch is *fully wet*, so a stored mix would open the
		// first track of a session on a burst of reverb while the ramp pulled it
		// back down.
		const { dry, wet } = this.crossfade();
		this.dryGain.gain.value = dry;
		this.wetGain.gain.value = wet;
		this.convolver = context.createConvolver();
		// Left at its default of true, which scales a response by a measure of its
		// own power. A tail this long carries far more energy than the dry signal
		// it came from, and unnormalised it would arrive loud enough that the mix
		// slider read as a volume control for most of its travel.
		this.convolver.normalize = true;

		input.connect(this.dryGain).connect(mix);
		input.connect(this.convolver).connect(this.wetGain).connect(mix);
		this.apply();
		return mix;
	}

	/**
	 * Forget the nodes, for a graph that failed to come up. The settings survive;
	 * only the chain they were being written to is gone.
	 */
	release(): void {
		this.context = null;
		this.convolver = null;
		this.dryGain = null;
		this.wetGain = null;
		// An AudioBuffer belongs to the sample rate it was made at, and the next
		// context is not promised to share it.
		this.impulse = null;
	}

	/**
	 * Put the speed on the element.
	 *
	 * **Both properties are written, and `defaultPlaybackRate` is the load-bearing
	 * one.** Assigning a src runs the media element load algorithm, whose step 8
	 * sets `playbackRate` from `defaultPlaybackRate` — so writing it here is the
	 * whole of why a track change carries the speed over instead of dropping back
	 * to 1×. `playbackRate` is what is heard before the next load.
	 */
	private applyRate(): void {
		if (this.audio.defaultPlaybackRate !== this.rate) {
			this.audio.defaultPlaybackRate = this.rate;
		}
		if (this.audio.playbackRate !== this.rate) {
			this.audio.playbackRate = this.rate;
		}
		// The whole of the varispeed effect. Left alone, a browser time-stretches
		// to hold the pitch where it was; off, the pitch follows the speed the way
		// a record played at the wrong speed does.
		this.audio.preservesPitch = this.preservePitch;
	}

	// --- internals ---

	/**
	 * Land a change, on the element and nodes and then on the subscribers. Every
	 * setter ends here, so a change cannot reach the audio without reaching the UI
	 * that describes it, or the other way about.
	 */
	private commit(): void {
		this.apply();
		this.snapshot = this.buildSnapshot();
		this.subscribers.forEach((notify) => notify());
	}

	private apply(): void {
		this.applyRate();

		const context = this.context;
		if (!context || !this.convolver || !this.dryGain || !this.wetGain) return;

		if (this.reverbMix > 0) {
			const impulse = (this.impulse ??= buildImpulse(context));
			// Only when it actually changes: assigning `buffer` resets the
			// convolver's state, and this runs on every frame of a dragged mix
			// slider, which would cut the tail sixty times a second.
			if (this.convolver.buffer !== impulse) this.convolver.buffer = impulse;
		}

		const at = context.currentTime;
		const { dry, wet } = this.crossfade();
		easeParam(this.dryGain.gain, dry, at);
		easeParam(this.wetGain.gain, wet, at);
	}

	/**
	 * The mix split into the two gains that carry it. Equal power rather than a
	 * linear 1 − mix, because the dry signal and the tail it produced are
	 * uncorrelated: summing them linearly dips about 3 dB through the middle of
	 * the sweep, where sin and cos hold the level. Zero is still an exact bypass
	 * and one is still fully wet.
	 */
	private crossfade(): { dry: number; wet: number } {
		const angle = (this.reverbMix * Math.PI) / 2;
		return { dry: Math.cos(angle), wet: Math.sin(angle) };
	}

	private buildSnapshot(): EffectsState {
		return {
			rate: this.rate,
			preservePitch: this.preservePitch,
			reverbMix: this.reverbMix,
		};
	}
}
