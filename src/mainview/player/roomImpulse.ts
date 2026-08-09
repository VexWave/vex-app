/**
 * The reverb's impulse responses, synthesised at runtime: a few passes over a
 * buffer, costing a few milliseconds on the frame that first raises the mix off
 * zero.
 *
 * Everything here ends in an `AudioBuffer`. `Effects` owns what happens to one.
 */

/**
 * A space the reverb can be in. The mix slider travels between two of these, so
 * everything that separates a cupboard from a cathedral lives here.
 */
export interface Room {
	/** Silence before the first reflection — how far away the walls are. */
	preDelaySec: number;
	/** How long the tail runs past the pre-delay. */
	tailSec: number;
	/**
	 * How long the tail takes to fall 60 dB — the room's size as it is heard.
	 * Kept shorter than `tailSec`, so what the closing fade removes is already
	 * inaudible by the time it is removed.
	 */
	rt60Sec: number;
	/** How long the discrete early reflections run before the tail takes over. */
	earlySec: number;
	/** How many arrivals that span holds. */
	earlyCount: number;
	/** Where the tail's lowpass sits as the tail opens, and where it closes to. */
	toneOpenHz: number;
	toneClosedHz: number;
	/** Which draw the room is built from — see `roomNoise`. */
	seed: number;
}

/**
 * The two rooms, and with them the whole of what the mix slider changes about
 * the space: near walls and a tail gone inside a second, out to far ones and a
 * tail that outlives the note that caused it.
 *
 * **The seeds differ, so the two are independent draws.** Uncorrelated signals
 * add in power, which is what holds the reverb at one level while the room
 * around it grows.
 */
export const SMALL: Room = {
	preDelaySec: 0.012,
	tailSec: 0.8,
	rt60Sec: 0.6,
	earlySec: 0.045,
	earlyCount: 14,
	toneOpenHz: 9500,
	toneClosedHz: 2200,
	seed: 0x5eed1e55,
};
export const LARGE: Room = {
	preDelaySec: 0.042,
	tailSec: 3.6,
	rt60Sec: 3.1,
	earlySec: 0.12,
	earlyCount: 26,
	toneOpenHz: 8500,
	toneClosedHz: 900,
	seed: 0x9e3779b9,
};

/** Time constant over which the diffuse tail rises to full density. */
const DIFFUSION_SEC = 0.02;
/**
 * The amplitude the reflection cluster opens at, against a tail `addTail` opens
 * at an RMS of 1 — so the first arrivals stand some 18 dB over the level the
 * tail starts from, and the last of them land level with it.
 */
const EARLY_LEVEL = 8;
/** Where the surfaces a reflection came off take the top off it. */
const EARLY_TONE_HZ = 6500;
/** Below this the room answers nothing, so the track keeps its own low end. */
const ROOM_FLOOR_HZ = 180;
/** How long the response takes to reach exactly zero at its end. */
const FADE_SEC = 0.25;

/**
 * A seeded pseudo-random sequence (mulberry32). Where the early reflections land
 * is most of the room's character, so a fixed seed gives one designed room every
 * launch — a room that holds still long enough to be tuned.
 */
function roomNoise(seed: number): () => number {
	let state = seed;
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
 * A room's impulse response.
 *
 * One generator runs across both channels, so left and right carry different
 * reflections. A two-channel response convolves left with left and right with
 * right, and it is that independence that spreads the room across the image.
 *
 * The head of the buffer stays silent: the pre-delay is baked into the response
 * because how late the first reflection arrives is how far away the wall is.
 */
export function buildImpulse(
	context: BaseAudioContext,
	room: Room,
): AudioBuffer {
	const rate = context.sampleRate;
	const head = Math.round(room.preDelaySec * rate);
	const buffer = context.createBuffer(
		2,
		head + Math.round(room.tailSec * rate),
		rate,
	);
	const random = roomNoise(room.seed);

	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const samples = buffer.getChannelData(channel);
		addEarlyReflections(samples, head, rate, random, room);
		addTail(samples, head, rate, random, room);
		clearLowEnd(samples, rate);
		normalise(samples);
	}
	return buffer;
}

/**
 * The handful of discrete reflections off the nearest surfaces.
 *
 * **This is what a room is recognised by.** A pattern of distinct arrivals reads
 * as a space at levels far below where a diffuse tail begins to read as anything
 * at all, which is what the bottom of the slider lives on. They carry about 3%
 * of the response's energy and most of what it sounds like.
 */
function addEarlyReflections(
	samples: Float32Array,
	head: number,
	rate: number,
	random: () => number,
	room: Room,
): void {
	const span = Math.round(room.earlySec * rate);
	const cluster = new Float32Array(span);
	for (let i = 0; i < room.earlyCount; i++) {
		// One reflection per slot, jittered inside it, and the slots stretched so
		// they arrive thin and thicken towards the tail: the near surfaces answer
		// first and alone, the far ones later and several at once.
		const when = ((i + random()) / room.earlyCount) ** 0.6;
		const at = Math.min(span - 1, Math.floor(when * span));
		// Down to the level the tail opens at, so the cluster hands over to it.
		const level = EARLY_LEVEL ** (1 - when) * (0.75 + random() * 0.5);
		// Half of them arrive inverted, which scatters the transient that caused
		// them across the cluster.
		cluster[at] += random() < 0.5 ? -level : level;
	}

	// Surfaces take the top off what they return, which is what gives each
	// arrival the shape of a reflection. `makeup` puts back the power the lowpass
	// took with the highs, as in `addTail`.
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
 * It fades *in* under the early reflections, because full density is reached by
 * reflections meeting each other, which takes as long as it takes them to cross
 * the room.
 */
function addTail(
	samples: Float32Array,
	head: number,
	rate: number,
	random: () => number,
	room: Room,
): void {
	const length = samples.length - head;
	const fadeFrom = length - Math.round(FADE_SEC * rate);
	// Per-sample multipliers: 60 dB over `rt60Sec` for the decay, and the density
	// approaching full over `DIFFUSION_SEC`.
	const decayStep = Math.exp(Math.log(0.001) / (room.rt60Sec * rate));
	const buildStep = Math.exp(-1 / (DIFFUSION_SEC * rate));
	const open = lowpassCoefficient(room.toneOpenHz, rate);
	const closed = lowpassCoefficient(room.toneClosedHz, rate);
	// Geometric, so the lowpass closes by even musical intervals.
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
		// A lowpass takes power out along with the highs, and this one closes as it
		// goes. Putting that power back is what keeps the tail running the length
		// `rt60Sec` sets while it darkens.
		const level = filtered * Math.sqrt((2 - coefficient) / coefficient);

		let envelope = decay * (1 - undiffused);
		if (i >= fadeFrom) {
			// To exactly zero at the last sample: an exponential truncated while
			// still audible is a click.
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
 * A room that answers the bass hands it back smeared across seconds, under the
 * bass the track is playing now — which is the whole of what a mix turning to
 * mud is, and most of why a reverb ends up sounding like it swallowed the song.
 * Below `ROOM_FLOOR_HZ` the track keeps its low end to itself.
 *
 * Two one-pole passes, for a 12 dB an octave slope steep enough to clear the
 * bass with the corner still below the instruments.
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
 * as it was handed and the gains are the only thing deciding the level. **Both
 * rooms get it**, which is what makes them interchangeable at a given gain: the
 * small one packs that energy into 0.8 s and the large one spreads it over 3.6,
 * so the morph lengthens the room while the level holds.
 *
 * `ConvolverNode.normalize` is left off in favour of this. Its calibration is a
 * fixed one, which lands a response as long as `LARGE` well below unity, where
 * unit energy puts both rooms at the level `writeLevels` assumes.
 */
function normalise(samples: Float32Array): void {
	let energy = 0;
	for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
	if (energy <= 0) return;
	const scale = 1 / Math.sqrt(energy);
	for (let i = 0; i < samples.length; i++) samples[i] *= scale;
}
