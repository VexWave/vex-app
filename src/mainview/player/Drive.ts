import { clamp } from "@/lib/utils";
import {
	easeParam,
	writeRamp,
	writeValue,
	type GraphStage,
	type ParamWriter,
} from "./audioGraph";
import { measureProgramLevel } from "./programLevel";

/**
 * Where a mastered track sits, in dBFS and as RMS. The travel below is scaled
 * against it, and it stands in for any track whose own level has not been read.
 */
const PROGRAM_DBFS = -16;
const PROGRAM_RMS = 10 ** (PROGRAM_DBFS / 20);

/**
 * The drive at either end of the slider's travel, in dB.
 *
 * The top is figured against the nominal level rather than the measured one, so
 * that a slider position is the same amount of saturation on every track.
 *
 * The bottom sits *below* unity because the curve is read over a fixed [-1, 1]:
 * at a slope of 1 `tanh` has already bent well inside that domain, so the first
 * notch off the bypass would take a decibel and a half off every full-scale peak.
 * Twelve dB under, the curve is straight across the domain to within a tenth of a
 * dB and `post` hands the twelve back.
 */
const OVERDRIVE_DB = 8;
const MIN_DB = -12;

const MAX_DB = OVERDRIVE_DB - PROGRAM_DBFS;

const gainFor = (amount: number): number =>
	10 ** ((MIN_DB + (MAX_DB - MIN_DB) * amount) / 20);

/**
 * Approach of the makeup when a measured level lands, in seconds. Far longer than
 * a control's, because nobody asked for this one and it must not read as a move.
 */
const MAKEUP_TAU = 0.25;

/**
 * The low shelf the top of the slider puts ahead of the saturator, in dB, and
 * where it turns over.
 *
 * A preamp turned up is heard as bass because the ear's response flattens as level
 * rises — the one part of that sound a stage holding its output level cannot be
 * given for free, so it is asked for outright. Ahead of the saturator, where the
 * low end also drives the harmonics that make it read as weight rather than boom.
 */
const MAX_SHELF_DB = 6;
const SHELF_HZ = 100;

/**
 * How much of a track's energy the shelf reaches, and how much of what it adds is
 * heard as level. The second is far smaller because the weighting a loudness meter
 * applies holds the low end some 10 dB down: taking all of the added energy back
 * off the output would leave a bass lift sounding like everything else had been
 * turned down.
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
 * `tanh`'s slope at the origin is exactly `gain`, so quiet passages take the
 * drive's dB and nothing else, and it approaches full scale without reaching it,
 * so loud ones round off against the ceiling instead of striking it. It is also
 * long flat by the time the clamp arrives, which therefore adds no corner.
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
 * The spread is modelled; only the level it is evaluated at comes from the track,
 * read once off the head of the file. A makeup that followed the signal as it
 * played would ride the track's own dynamics back at it — a chorus gives up
 * several dB where the verse before it gave up none — and the level would move
 * while nobody was touching anything.
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
 * volume reads. The setting stands whether or not there is a graph to apply it
 * to; `attach` marries the two.
 */
export class Drive implements GraphStage {
	private amount = 0;
	private graph: DriveGraph | null = null;
	/** The loaded track's own level, standing at the nominal one until read. */
	private program = PROGRAM_RMS;
	private scan: AbortController | null = null;

	constructor(private readonly audio: HTMLAudioElement) {
		// Neither listener is ever removed: one element and one Drive, both alive
		// for as long as the app is.
		audio.addEventListener("volumechange", this.followVolume);
		audio.addEventListener("loadstart", this.followTrack);
	}

	get value(): number {
		return this.amount;
	}

	/** True if the setting moved, which is what the owner reports onwards. */
	set(amount: number): boolean {
		const next = clamp(amount, 0, 1, 0);
		if (next === this.amount) return false;
		const bypassed = this.amount === 0;
		this.amount = next;
		// Only worth a request once there is a makeup to be right about, and most
		// sessions never leave the bypass.
		if (bypassed) this.measure();
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

	/** The measurement belongs to the track, not the graph, so it survives this. */
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
	 * stage does; either one easing in behind the other leaves that product wrong
	 * for the length of the ramp, by the entire ratio between the two settings.
	 * Only the shelf is eased, its coefficients being the one thing here that
	 * clicks when stepped.
	 */
	private writeLevels(graph: DriveGraph, write: ParamWriter): void {
		write(graph.shelf.gain, MAX_SHELF_DB * this.amount);
		if (this.amount === 0) {
			graph.shaper.curve = null;
			graph.post.gain.value = 1;
			return;
		}
		const volume = this.audio.volume;
		const gain = gainFor(this.amount);
		graph.shaper.curve = curveFor(volume > 0 ? gain / volume : gain);
		graph.post.gain.value = this.postGain();
	}

	/**
	 * A level that has just been read moves `post` alone, the curve being a
	 * function of the setting and the volume. Eased rather than written, and over
	 * a long tau: a measurement can land several dB from where the nominal level
	 * put it, and a step that size onto a running gain clicks.
	 */
	private writeMakeup(): void {
		const graph = this.graph;
		if (!graph || this.amount === 0) return;
		easeParam(
			graph.post.gain,
			this.postGain(),
			graph.context.currentTime,
			MAKEUP_TAU,
		);
	}

	/**
	 * What `post` hands back of what the curve and the shelf take off, figured at
	 * the level the loaded track is actually cut at. The shelf enters twice at two
	 * different shares: the saturator is driven by the energy it really adds, while
	 * only the part of that energy heard as level comes back off the output.
	 *
	 * The equalizer stands between the source and this stage and is not in the
	 * level, which is read from the file — so bands pushed hard are drive that
	 * comes out quieter than it went in, by a dB or two at a realistic setting.
	 */
	private postGain(): number {
		const shelfDb = MAX_SHELF_DB * this.amount;
		const driven = this.program * shelfFactor(shelfDb, BASS_ENERGY_SHARE);
		const target = this.program * shelfFactor(shelfDb, BASS_LOUDNESS_SHARE);
		return (
			(this.audio.volume * target) / drivenRms(gainFor(this.amount), driven)
		);
	}

	/** The volume is in the curve, so a change to it is a new curve, and a new `post`. */
	private followVolume = (): void => {
		const graph = this.graph;
		if (!graph || this.amount === 0) return;
		this.writeLevels(graph, writeValue);
	};

	/**
	 * The nominal level goes back in *and* is written, so a track whose own level
	 * never arrives is compensated as an unknown track rather than as the one
	 * before it.
	 */
	private followTrack = (): void => {
		this.scan?.abort();
		this.scan = null;
		this.program = PROGRAM_RMS;
		this.writeMakeup();
		this.measure();
	};

	/** Reads the loaded track's level, once, and only if the stage is in the path. */
	private measure(): void {
		const url = this.audio.currentSrc;
		if (!url || this.amount === 0 || this.scan) return;
		const scan = new AbortController();
		this.scan = scan;
		void measureProgramLevel(url, scan.signal).then((rms) => {
			if (this.scan === scan) this.scan = null;
			// Skipped on while the bytes were in flight: the answer belongs to a
			// track the element has already left.
			if (rms === null || this.audio.currentSrc !== url) return;
			this.program = rms;
			this.writeMakeup();
		});
	}
}
