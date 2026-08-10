import { clamp } from "@/lib/utils";
import {
	writeRamp,
	writeValue,
	type GraphStage,
	type ParamWriter,
} from "./audioGraph";

/**
 * Where a mastered track sits, in dBFS and as RMS. Both the ceiling below and the
 * makeup are figured at it: how hard the curve drives, and what that costs in
 * level, are questions about the material going in.
 */
const PROGRAM_DBFS = -16;
const PROGRAM_RMS = 10 ** (PROGRAM_DBFS / 20);

/**
 * How far past the knee the top of the slider carries that level, in dB. `tanh`
 * bends at an input around 1/gain, so this is what the end of the travel is: a
 * track driven far enough beyond the bend that the quiet passages saturate too,
 * not only the peaks above them.
 */
const OVERDRIVE_DB = 8;

const MAX_DB = OVERDRIVE_DB - PROGRAM_DBFS;

const gainFor = (amount: number): number => 10 ** ((MAX_DB * amount) / 20);

/**
 * The low shelf the top of the slider puts ahead of the saturator, in dB, and
 * where it turns over.
 *
 * A preamp turned up is heard as bass because the ear's response flattens as
 * level rises — the one part of that sound a stage holding its output level
 * cannot be given for free, so it is asked for outright. Ahead of the saturator,
 * where the low end also drives the harmonics that make it read as weight rather
 * than boom.
 */
const MAX_SHELF_DB = 6;
const SHELF_HZ = 100;

/**
 * How much of a track's energy the shelf reaches, and how much of what it adds is
 * heard as level. The second is far smaller because the weighting a loudness
 * meter applies holds the low end some 10 dB down: a shelf adds a great deal of
 * energy and little loudness, and taking all of it back off the output is what
 * would leave a bass lift sounding like everything else had been turned down.
 */
const BASS_ENERGY_SHARE = 0.5;
const BASS_LOUDNESS_SHARE = 0.15;

/** What a shelf of `db` multiplies a signal by, over the share it reaches. */
const shelfFactor = (db: number, share: number): number =>
	Math.sqrt(1 + share * (10 ** (db / 10) - 1));

const CURVE_POINTS = 2048;

/**
 * The saturator's transfer curve, over the [-1, 1] a WaveShaper clamps its input
 * to before reading one.
 *
 * `tanh` is the curve where the slider's two promises are one number: its slope
 * at the origin is exactly `gain`, so quiet passages take the drive's dB and
 * nothing else, and it approaches full scale without reaching it, so loud ones
 * round off against the ceiling instead of striking it. It is also long flat by
 * the time the clamp arrives, which therefore adds no corner of its own.
 */
function curveFor(gain: number): Float32Array<ArrayBuffer> {
	const curve = new Float32Array(CURVE_POINTS);
	for (let i = 0; i < CURVE_POINTS; i++) {
		curve[i] = Math.tanh(gain * ((i / (CURVE_POINTS - 1)) * 2 - 1));
	}
	return curve;
}

/** Points in the integral below, and how many σ out from the middle it runs. */
const MODEL_POINTS = 256;
const MODEL_SPAN = 4;

/**
 * What the curve leaves of a signal whose own RMS is `sigma`, as RMS. Music's
 * samples are near enough normally distributed for this.
 *
 * **A model of program material rather than a measurement of the track, and that
 * is the point.** What saturation costs in level swings with the material — a
 * chorus gives up several dB where the verse before it gave up none — so a makeup
 * read off the signal rides the track's own dynamics back at it, and the level
 * moves while nobody is touching anything.
 */
function drivenRms(gain: number, sigma: number): number {
	const span = MODEL_SPAN * sigma;
	const step = (2 * span) / (MODEL_POINTS - 1);
	let weight = 0;
	let square = 0;
	for (let i = 0; i < MODEL_POINTS; i++) {
		const x = -span + i * step;
		// The bell's own scaling cancels out of the ratio below, so it is left off.
		const w = Math.exp(-(x * x) / (2 * sigma * sigma));
		const y = Math.tanh(gain * Math.min(Math.max(x, -1), 1));
		weight += w;
		square += w * y * y;
	}
	return Math.sqrt(square / weight);
}

/**
 *     input ─► shelf ─► shaper ─► post ─►
 *
 * One path, and the whole track goes down it at every setting: at rest the curve
 * is dropped, which is the pass-through the spec gives a WaveShaper without one.
 * No dry branch alongside, so the shaper is free to oversample — the latency that
 * costs has nothing to comb against.
 */
interface DriveGraph {
	context: AudioContext;
	shelf: BiquadFilterNode;
	shaper: WaveShaperNode;
	post: GainNode;
}

function buildDrive(context: AudioContext, input: AudioNode): DriveGraph {
	const shelf = context.createBiquadFilter();
	shelf.type = "lowshelf";
	shelf.frequency.value = SHELF_HZ;
	const shaper = context.createWaveShaper();
	// A preamp's bandwidth runs far past where it distorts; sampled audio's does
	// not, and harmonics thrown past half the sample rate fold back down as tones
	// belonging to no note in the track.
	shaper.oversample = "4x";
	const post = context.createGain();
	input.connect(shelf).connect(shaper).connect(post);
	return { context, shelf, shaper, post };
}

/**
 * A preamp driven hard, at the same character and the same level whatever the
 * volume reads, and the setting that describes it. The setting stands whether or
 * not there is a graph to apply it to; `attach` marries the two.
 */
export class Drive implements GraphStage {
	private amount = 0;
	private graph: DriveGraph | null = null;

	constructor(private readonly audio: HTMLAudioElement) {
		audio.addEventListener("volumechange", this.followVolume);
	}

	get value(): number {
		return this.amount;
	}

	/** True if the setting moved, which is what the owner reports onwards. */
	set(amount: number): boolean {
		const next = clamp(amount, 0, 1, 0);
		if (next === this.amount) return false;
		this.amount = next;
		const graph = this.graph;
		if (graph) this.writeLevels(graph, writeRamp(graph.context.currentTime));
		return true;
	}

	attach(context: AudioContext, input: AudioNode): AudioNode {
		const graph = buildDrive(context, input);
		this.graph = graph;
		// As values, so the graph opens at the current setting rather than sliding
		// there from the 0 dB a shelf comes up at.
		this.writeLevels(graph, writeValue);
		return graph.post;
	}

	release(): void {
		this.graph = null;
	}

	/**
	 * **Folding the element's volume into the curve's slope is the whole of what
	 * this stage is for.** Volume belongs to the element, so it is spent before the
	 * graph sees the track: left in, it carries the track below the knee and the
	 * distortion with it, and the sound can only be had loud. A slope of
	 * `gain / volume` meets a track already scaled by `volume` and saturates it by
	 * exactly `gain`; `post` puts the volume back.
	 *
	 * Dividing it out with a gain ahead of the shaper instead would not do — the
	 * shaper clamps its input to [-1, 1] before reading the curve, so at any volume
	 * under full the peaks would land past the end of the curve and be squared off
	 * there, which is the sound depending on the volume again.
	 *
	 * **The curve and `post` land together, as values.** Their product is what the
	 * stage does, and it moves smoothly across the whole travel; either one easing
	 * in behind the other leaves that product wrong for the length of the ramp, by
	 * the entire ratio between the two settings. Only the shelf is eased, its
	 * coefficients being the one thing here that clicks when stepped.
	 */
	private writeLevels(graph: DriveGraph, write: ParamWriter): void {
		const shelfDb = MAX_SHELF_DB * this.amount;
		write(graph.shelf.gain, shelfDb);
		if (this.amount === 0) {
			graph.shaper.curve = null;
			graph.post.gain.value = 1;
			return;
		}
		const volume = this.audio.volume;
		const gain = gainFor(this.amount);
		graph.shaper.curve = curveFor(volume > 0 ? gain / volume : gain);
		graph.post.gain.value = volume * this.makeupFor(shelfDb, gain);
	}

	/**
	 * The gain that hands back what the curve and the shelf take off. The shelf
	 * enters twice at two different shares: the saturator is driven by the energy it
	 * really adds, while only the part of that energy heard as level comes back off
	 * the output.
	 */
	private makeupFor(shelfDb: number, gain: number): number {
		const driven = PROGRAM_RMS * shelfFactor(shelfDb, BASS_ENERGY_SHARE);
		const target = PROGRAM_RMS * shelfFactor(shelfDb, BASS_LOUDNESS_SHARE);
		return target / drivenRms(gain, driven);
	}

	/** The volume is in the curve, so a change to it is a new curve, and a new `post`. */
	private followVolume = (): void => {
		const graph = this.graph;
		if (!graph || this.amount === 0) return;
		this.writeLevels(graph, writeValue);
	};
}
