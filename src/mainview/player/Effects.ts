import { clamp } from "@/lib/utils";
import { easeParam, type GraphStage } from "./audioGraph";
import { buildImpulse, LARGE, SMALL, type Room } from "./roomImpulse";

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

/**
 * The most reverb the slider will send, as a gain on the wet branch.
 *
 * The responses are scaled to unit energy, so a wet gain of 1 hands back about
 * the power it was given — an equal-power wash. Half of that puts the room a
 * steady 6 dB under the track at the top of the travel: drenched, with the track
 * still plainly the thing in front of it.
 */
const WET_MAX = 0.5;

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
	 * How large a room the track is in, and how much of it comes back. 0 is an
	 * exact bypass, 1 a hall at the fullest send — see `writeLevels`.
	 */
	reverbMix: number;
}

/**
 * One room in the graph.
 *
 * Its response is built on the first change that makes it audible, so a session
 * that never touches the reverb never builds one, and kept from then on: an
 * `AudioBuffer` outlives every mix change, and lives as long as the context it
 * was made for.
 */
class RoomBranch {
	readonly gain: GainNode;
	private readonly convolver: ConvolverNode;
	private impulse: AudioBuffer | null = null;

	constructor(
		private readonly context: AudioContext,
		private readonly room: Room,
		input: AudioNode,
		into: AudioNode,
	) {
		this.convolver = context.createConvolver();
		// The responses arrive scaled to unit energy — see `normalise` in
		// `roomImpulse` for what that calibration buys.
		this.convolver.normalize = false;
		this.gain = context.createGain();
		input.connect(this.convolver).connect(this.gain).connect(into);
	}

	load(): void {
		this.impulse ??= buildImpulse(this.context, this.room);
		// Assigning `buffer` resets the convolver's state, and this runs on every
		// frame of a dragged mix slider: the guard is what carries the tail
		// through a drag.
		if (this.convolver.buffer !== this.impulse) {
			this.convolver.buffer = this.impulse;
		}
	}
}

/**
 * The reverb as it exists in the graph, built by `attach` and dropped whole by
 * `release`:
 *
 *     input ─┬──────────────────────────────────► mix ─►
 *            ├─► small ─┐                          │
 *            └─► large ─┴─► wet ───────────────────┘
 *
 * **The dry path is a bare connection.** The track reaches `mix` at full level
 * wherever the slider sits; the two branch gains trade which room is heard, and
 * `wet` says how much of it comes back.
 */
interface ReverbGraph {
	context: AudioContext;
	/** The summing node, carrying the bus trim — see `writeLevels`. */
	mix: GainNode;
	wet: GainNode;
	small: RoomBranch;
	large: RoomBranch;
}

function buildReverb(context: AudioContext, input: AudioNode): ReverbGraph {
	const mix = context.createGain();
	const wet = context.createGain();
	wet.connect(mix);
	input.connect(mix);
	return {
		context,
		mix,
		wet,
		small: new RoomBranch(context, SMALL, input, wet),
		large: new RoomBranch(context, LARGE, input, wet),
	};
}

/**
 * Playback speed and reverb, and the settings that describe them.
 *
 * It holds those settings whether or not there is a graph to apply them to, and
 * `attach` marries the two once `AudioPlayer` builds the graph on the first
 * playback. A store of its own, so dragging a slider re-renders the panel and
 * leaves every track row in the app where it was.
 *
 * Speed is a property of the element, which puts it *upstream* of
 * `createMediaElementSource` — the equalizer, the analyser and the backdrop glow
 * all follow a speed change without knowing about it.
 */
export class Effects implements GraphStage {
	private subscribers = new Set<() => void>();
	private rate = 1;
	private preservePitch = false;
	private reverbMix = 0;
	private snapshot: EffectsState;

	/** Null until the playback graph is built; the settings stand without it. */
	private graph: ReverbGraph | null = null;

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
	 * commit, so a subscriber always sees the pair reset together.
	 *
	 * `preservePitch` stands, as the equalizer's switch does through its own
	 * reset — it is a mode, and reset returns values.
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
	 * Build the reverb and hang it off `input`, per `GraphStage`.
	 *
	 * The levels are written as values, so the graph opens already at the current
	 * mix. A GainNode comes up at 1, which on the wet branch is fully wet, and the
	 * panel lives in the player bar — where the mix can be raised long before a
	 * first playback builds the graph.
	 */
	attach(context: AudioContext, input: AudioNode): AudioNode {
		const graph = buildReverb(context, input);
		this.graph = graph;
		this.loadImpulses();
		this.writeLevels(graph, (param, value) => {
			param.value = value;
		});
		return graph.mix;
	}

	/**
	 * Forget the nodes, for a graph that failed to come up. The settings survive;
	 * only the chain they were being written to is gone. The responses go with it:
	 * an AudioBuffer belongs to the sample rate it was made at, and the next
	 * context is free to have another.
	 */
	release(): void {
		this.graph = null;
	}

	/**
	 * Put the speed on the element.
	 *
	 * **Both properties are written, and `defaultPlaybackRate` is the load-bearing
	 * one.** Assigning a src runs the media element load algorithm, whose step 8
	 * sets `playbackRate` from `defaultPlaybackRate` — so writing it here is the
	 * whole of why a track change carries the speed over. `playbackRate` is what
	 * is heard before the next load.
	 */
	private applyRate(): void {
		if (this.audio.defaultPlaybackRate !== this.rate) {
			this.audio.defaultPlaybackRate = this.rate;
		}
		if (this.audio.playbackRate !== this.rate) {
			this.audio.playbackRate = this.rate;
		}
		// The whole of the varispeed effect. On, a browser time-stretches to hold
		// the pitch where it was; off, the pitch follows the speed the way a record
		// played at the wrong speed does.
		this.audio.preservesPitch = this.preservePitch;
	}

	// --- internals ---

	/**
	 * Land a change, on the element and nodes and then on the subscribers. Every
	 * setter ends here, so a change reaches the audio and the UI that describes it
	 * together.
	 */
	private commit(): void {
		this.apply();
		this.snapshot = this.buildSnapshot();
		this.subscribers.forEach((notify) => notify());
	}

	private apply(): void {
		this.applyRate();

		const graph = this.graph;
		if (!graph) return;
		this.loadImpulses();
		const at = graph.context.currentTime;
		this.writeLevels(graph, (param, value) => easeParam(param, value, at));
	}

	/**
	 * Both rooms, whatever the mix reads: the morph has the far one fading in from
	 * the moment the slider leaves the near one. A mix of zero is silent on both,
	 * so a response waits until there is something to hear.
	 */
	private loadImpulses(): void {
		if (this.reverbMix <= 0 || !this.graph) return;
		this.graph.small.load();
		this.graph.large.load();
	}

	/**
	 * Put the mix on the four gains that carry it, `write` deciding whether the
	 * values arrive as a step or a ramp. The one place that maps a level to a
	 * gain, so `attach` and `apply` stay in agreement.
	 *
	 * The slider does two things at once, which together are what "more reverb"
	 * means. `small`/`large` turn the space itself, at constant power over
	 * independent responses, so it lengthens from a room to a hall while the
	 * reverb holds its level. `wet` says how much of that comes back, on a quarter
	 * sine so it climbs fastest where the slider leaves zero — which is where a
	 * room is heard *appearing*, while past the middle a room already there only
	 * deepens.
	 *
	 * The trim on `mix` is the one thing the dry signal feels. The wet return is
	 * uncorrelated with what produced it, so the two add in power, and dividing
	 * the bus by that keeps the whole mix at the level the track arrived at and
	 * its peaks off the ceiling. It scales both branches together, which leaves
	 * the balance between them untouched and costs the track 1 dB across the
	 * entire travel.
	 */
	private writeLevels(
		graph: ReverbGraph,
		write: (param: AudioParam, value: number) => void,
	): void {
		const turn = (this.reverbMix * Math.PI) / 2;
		const wet = WET_MAX * Math.sin(turn);
		write(graph.mix.gain, 1 / Math.hypot(1, wet));
		write(graph.wet.gain, wet);
		write(graph.small.gain.gain, Math.cos(turn));
		write(graph.large.gain.gain, Math.sin(turn));
	}

	private buildSnapshot(): EffectsState {
		return {
			rate: this.rate,
			preservePitch: this.preservePitch,
			reverbMix: this.reverbMix,
		};
	}
}
