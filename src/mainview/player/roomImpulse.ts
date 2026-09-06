export interface Room {
	preDelaySec: number;
	tailSec: number;
	rt60Sec: number;
	earlySec: number;
	earlyCount: number;
	toneOpenHz: number;
	toneClosedHz: number;
	seed: number;
}

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

const DIFFUSION_SEC = 0.02;
const EARLY_LEVEL = 8;
const EARLY_TONE_HZ = 6500;
const ROOM_FLOOR_HZ = 180;
const FADE_SEC = 0.25;

function roomNoise(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function lowpassCoefficient(hz: number, rate: number): number {
	return 1 - Math.exp((-2 * Math.PI * hz) / rate);
}

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
		const when = ((i + random()) / room.earlyCount) ** 0.6;
		const at = Math.min(span - 1, Math.floor(when * span));
		const level = EARLY_LEVEL ** (1 - when) * (0.75 + random() * 0.5);
		cluster[at] += random() < 0.5 ? -level : level;
	}

	const coefficient = lowpassCoefficient(EARLY_TONE_HZ, rate);
	const makeup = Math.sqrt((2 - coefficient) / coefficient);
	let filtered = 0;
	for (let i = 0; i < span; i++) {
		filtered += coefficient * (cluster[i] - filtered);
		samples[head + i] += filtered * makeup;
	}
}

function addTail(
	samples: Float32Array,
	head: number,
	rate: number,
	random: () => number,
	room: Room,
): void {
	const length = samples.length - head;
	const fadeFrom = length - Math.round(FADE_SEC * rate);
	const decayStep = Math.exp(Math.log(0.001) / (room.rt60Sec * rate));
	const buildStep = Math.exp(-1 / (DIFFUSION_SEC * rate));
	const open = lowpassCoefficient(room.toneOpenHz, rate);
	const closed = lowpassCoefficient(room.toneClosedHz, rate);
	const toneStep = (closed / open) ** (1 / length);

	let decay = 1;
	let undiffused = 1;
	let coefficient = open;
	let filtered = 0;
	for (let i = 0; i < length; i++) {
		const white = (random() * 2 - 1) * Math.sqrt(3);
		filtered += coefficient * (white - filtered);
		const level = filtered * Math.sqrt((2 - coefficient) / coefficient);

		let envelope = decay * (1 - undiffused);
		if (i >= fadeFrom) {
			const t = (i - fadeFrom + 1) / (length - fadeFrom);
			envelope *= (1 + Math.cos(Math.PI * t)) / 2;
		}
		samples[head + i] += level * envelope;

		decay *= decayStep;
		undiffused *= buildStep;
		coefficient *= toneStep;
	}
}

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

function normalise(samples: Float32Array): void {
	let energy = 0;
	for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
	if (energy <= 0) return;
	const scale = 1 / Math.sqrt(energy);
	for (let i = 0; i < samples.length; i++) samples[i] *= scale;
}
