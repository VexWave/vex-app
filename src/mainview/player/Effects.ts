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

/** Silence before the first reflection — how far away the walls are. */
const PRE_DELAY_SEC = 0.028;
/** How long the tail runs, in seconds; the response is this plus the pre-delay. */
const TAIL_SEC = 2.6;
/**
 * How long the tail takes to fall 60 dB — the room's size as it is heard. Kept
 * shorter than the buffer, so what the closing fade removes is already inaudible
 * by the time it is removed.
 */
const RT60_SEC = 2.2;
/** Time constant over which the diffuse tail rises to full density. */
const DIFFUSION_SEC = 0.02;
/** How long the discrete early reflections run before the tail has taken over. */
const EARLY_SEC = 0.09;
/** How many of them that span holds. */
const EARLY_COUNT = 20;
/**
 * The amplitude the reflection cluster opens at, against a tail `addTail` opens
 * at an RMS of 1 — so the first arrivals stand some 18 dB over the level the
 * tail starts from, and the last of them land level with it.
 */
const EARLY_LEVEL = 8;
/** Where the surfaces a reflection came off take the top off it. */
const EARLY_TONE_HZ = 6500;
/** Where the tail's lowpass sits as the tail opens, and where it has closed to. */
const TAIL_TONE_OPEN_HZ = 9000;
const TAIL_TONE_CLOSED_HZ = 1100;
/** Below this the room answers nothing, so the track keeps its own low end. */
const ROOM_FLOOR_HZ = 180;
/** How long the response takes to reach exactly zero at its end. */
const FADE_SEC = 0.25;
/**
 * How far the mix leans wet of an even split: it puts the point where the two
 * branches meet at 45% of the slider rather than 54%, so the middle of the
 * travel reads as a track *in* a room rather than as the place a room begins to
 * appear. It tilts the balance and not the level — `crossfade` holds the pair at
 * constant power whatever this is set to.
 */
const WET_TILT = 1.3;
/**
 * What is left of the dry signal at a full mix. Not zero: a mix slider that ends
 * in silence spends its last third taking the track away, where this one spends
 * it putting the track further into the room.
 */
const DRY_FLOOR = 0.35;

export interface EffectsState {
	/** Playback speed as a multiple of the recording's own; 1 is untouched. */
	rate: number;
	/**
	 * Whether the pitch is held while the speed changes. Off is the tape effect,
	 * where slowing down also drops the key; on is the time-stretch a browser
	 * does by default.
	 */
	preservePitch: boolean;
	/**
	 * How far into the room the track sits. 0 is an exact bypass; 1 is as far as
	 * the slider goes, which `DRY_FLOOR` keeps short of fully wet.
	 */
	reverbMix: number;
}

/**
 * A fixed pseudo-random sequence (mulberry32), drawn on rather than
 * `Math.random`. Where the early reflections below land is most of the room's
 * character, so this is one designed room every launch rather than a fresh draw
 * each time: a room that differs per session is a room that can't be tuned.
 */
function roomNoise(): () => number {
	let state = 0x5eed1e55;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** How much of each new sample a one-pole lowpass at `hz` takes. */
function lowpassCoefficient(hz: number, rate: number): number {
	return 1 - Math.exp((-2 * Math.PI * hz) / rate);
}

/**
 * The reverb's impulse response, made rather than fetched: a few passes over a
 * buffer cost less than a file, a request and a decode would, and a few
 * milliseconds of the one frame that first raises the mix off zero.
 *
 * Each channel is built from its own draw, because a two-channel response
 * convolves left with left and right with right — independent reflections are
 * what spread the room across the image instead of piling it up in the middle.
 * The head of the buffer is left silent so the dry transient is heard before the
 * room answers it, baked in rather than given a DelayNode because how late the
 * first reflection arrives *is* how far away the wall is.
 */
function buildImpulse(context: BaseAudioContext): AudioBuffer {
	const rate = context.sampleRate;
	const head = Math.round(PRE_DELAY_SEC * rate);
	const buffer = context.createBuffer(
		2,
		head + Math.round(TAIL_SEC * rate),
		rate,
	);
	const random = roomNoise();

	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const samples = buffer.getChannelData(channel);
		addEarlyReflections(samples, head, rate, random);
		addTail(samples, head, rate, random);
		clearLowEnd(samples, rate);
		normalise(samples);
	}
	return buffer;
}

/**
 * The handful of discrete reflections off the nearest surfaces.
 *
 * **This is what a room is recognised by**, and the reason a small amount of
 * reverb can be heard as a room at all: a diffuse tail on its own only thickens
 * what it is mixed under, and has to be pushed most of the way up before it
 * reads as anything but a haze. A pattern of distinct arrivals reads as a space
 * well below that level, which is what the bottom of the slider lives on. They
 * carry about 3% of the response's energy and most of what it sounds like.
 */
function addEarlyReflections(
	samples: Float32Array,
	head: number,
	rate: number,
	random: () => number,
): void {
	const span = Math.round(EARLY_SEC * rate);
	const cluster = new Float32Array(span);
	for (let i = 0; i < EARLY_COUNT; i++) {
		// One reflection per slot, jittered inside it, and the slots stretched so
		// they arrive thin and thicken towards the tail: the near surfaces answer
		// first and alone, the far ones later and several at once.
		const when = ((i + random()) / EARLY_COUNT) ** 0.6;
		const at = Math.min(span - 1, Math.floor(when * span));
		// Down to the level the tail opens at, so the cluster hands over to the
		// tail instead of stopping in front of it.
		const level = EARLY_LEVEL ** (1 - when) * (0.75 + random() * 0.5);
		// Half of them arrive inverted. A cluster of one sign sums into a
		// thickened copy of the transient that made it, where mixed signs scatter.
		cluster[at] += random() < 0.5 ? -level : level;
	}

	// Surfaces take the top off what they return, and without this each arrival
	// is a single full-band sample — a tick rather than a reflection. `makeup`
	// puts back the power the lowpass took with the highs, as in `addTail`.
	const coefficient = lowpassCoefficient(EARLY_TONE_HZ, rate);
	const makeup = Math.sqrt((2 - coefficient) / coefficient);
	let filtered = 0;
	for (let i = 0; i < span; i++) {
		filtered += coefficient * (cluster[i] - filtered);
		samples[head + i] += filtered * makeup;
	}
}

/**
 * The diffuse tail: noise under a decay envelope, which is what a tail *is* once
 * the reflections in it are too many and too close to be told apart.
 *
 * It fades *in* under the early reflections rather than starting at full
 * density, because that density is reached by reflections meeting each other,
 * which takes as long as it takes them to cross the room.
 */
function addTail(
	samples: Float32Array,
	head: number,
	rate: number,
	random: () => number,
): void {
	const length = samples.length - head;
	const fadeFrom = length - Math.round(FADE_SEC * rate);
	// Per-sample factors rather than a curve evaluated per sample: 60 dB over
	// RT60_SEC for the decay, and the density approaching full over
	// DIFFUSION_SEC.
	const decayStep = Math.exp(Math.log(0.001) / (RT60_SEC * rate));
	const buildStep = Math.exp(-1 / (DIFFUSION_SEC * rate));
	const open = lowpassCoefficient(TAIL_TONE_OPEN_HZ, rate);
	const closed = lowpassCoefficient(TAIL_TONE_CLOSED_HZ, rate);
	// Geometric, so the lowpass closes by even intervals rather than even Hz.
	const toneStep = (closed / open) ** (1 / length);

	let decay = 1;
	let undiffused = 1;
	let coefficient = open;
	let filtered = 0;
	for (let i = 0; i < length; i++) {
		// Uniform noise carries a variance of 1/3; √3 opens the tail at an RMS of
		// 1, which is what EARLY_LEVEL is measured against.
		const white = (random() * 2 - 1) * Math.sqrt(3);
		filtered += coefficient * (white - filtered);
		// A lowpass takes power out along with the highs, and this lowpass closes
		// as it goes. Putting that power back is what separates a tail that
		// *darkens* from one that merely dies faster than the decay it was given —
		// the second is why a naive tail sounds shorter than the figure it was set.
		const level = filtered * Math.sqrt((2 - coefficient) / coefficient);

		let envelope = decay * (1 - undiffused);
		if (i >= fadeFrom) {
			// To exactly zero at the last sample: an exponential truncated while
			// still audible is a click, and one long enough not to be is a buffer
			// mostly spent on silence.
			const t = (i - fadeFrom + 1) / (length - fadeFrom);
			envelope *= (1 + Math.cos(Math.PI * t)) / 2;
		}
		samples[head + i] += level * envelope;

		decay *= decayStep;
		undiffused *= buildStep;
		coefficient *= toneStep;
	}
}

/**
 * Take the room's low end off.
 *
 * A room that answers the bass hands it back smeared across two seconds, under
 * the bass the track is playing now — which is the whole of what a mix turning
 * to mud is, and most of why a reverb ends up sounding like it swallowed the
 * song. Below `ROOM_FLOOR_HZ` the track keeps its low end to itself.
 *
 * Two one-pole passes for 12 dB an octave: at 6 the slope is shallow enough that
 * the corner has to be pushed up among the instruments to clear anything at all.
 */
function clearLowEnd(samples: Float32Array, rate: number): void {
	const alpha = 1 / (1 + (2 * Math.PI * ROOM_FLOOR_HZ) / rate);
	for (let pass = 0; pass < 2; pass++) {
		let lastIn = 0;
		let lastOut = 0;
		for (let i = 0; i < samples.length; i++) {
			const input = samples[i];
			lastOut = alpha * (lastOut + input - lastIn);
			lastIn = input;
			samples[i] = lastOut;
		}
	}
}

/**
 * Scale the response to unit energy, so convolving with it returns about as much
 * as it was handed and `crossfade` is the only thing deciding the level.
 *
 * This is the job `ConvolverNode.normalize` would do, and the reason it is
 * turned off: it works to a fixed calibration that leaves a response as long as
 * this one well below unity, so most of the mix slider's travel would be spent
 * bringing a wet branch that quiet up to where it can be heard at all.
 */
function normalise(samples: Float32Array): void {
	let energy = 0;
	for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
	if (energy <= 0) return;
	const scale = 1 / Math.sqrt(energy);
	for (let i = 0; i < samples.length; i++) samples[i] *= scale;
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
	 * commit rather than two setters, so a subscriber cannot catch the pair half
	 * reset.
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
		// 1, which on the wet branch is *fully wet*, so a mix raised before the
		// graph existed — the panel is in the player bar, and the graph waits for
		// the first playback — would open that track on a burst of reverb while the
		// ramp pulled it back down.
		const { dry, wet } = this.crossfade();
		this.dryGain.gain.value = dry;
		this.wetGain.gain.value = wet;
		this.convolver = context.createConvolver();
		// `normalise` has already scaled the response, to unit energy rather than
		// to the node's own calibration — see it for why that calibration is the
		// wrong thing to leave in charge of the mix.
		this.convolver.normalize = false;

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
	 * The mix split into the two gains that carry it.
	 *
	 * The wet gain follows a quarter sine, so it climbs fastest where the slider
	 * leaves zero — which is where a room is heard *appearing*, while past the
	 * middle a room already there only deepens.
	 *
	 * Then the pair is held at constant power. The dry signal and the tail it
	 * produced are uncorrelated, so their powers add rather than their amplitudes,
	 * and normalising the pair is what keeps every position on the slider at the
	 * level the track arrived at. Without it `WET_TILT` would be worth some 2 dB
	 * by the top of the travel, and the mix slider would be a volume control
	 * wearing a reverb's name.
	 */
	private crossfade(): { dry: number; wet: number } {
		const wetness = Math.sin((this.reverbMix * Math.PI) / 2) ** 2;
		const shared = (1 - DRY_FLOOR ** 2) * wetness;
		const dry = Math.sqrt(1 - shared);
		const wet = Math.sqrt(shared) * WET_TILT;
		const level = Math.hypot(dry, wet);
		return { dry: dry / level, wet: wet / level };
	}

	private buildSnapshot(): EffectsState {
		return {
			rate: this.rate,
			preservePitch: this.preservePitch,
			reverbMix: this.reverbMix,
		};
	}
}
