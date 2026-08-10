import { clamp } from "@/lib/utils";
import {
	writeRamp,
	writeValue,
	type GraphStage,
	type ParamWriter,
} from "./audioGraph";
import { buildImpulse, LARGE, SMALL, type Room } from "./roomImpulse";

/**
 * The most the slider will send, as a gain on the wet branch. The responses are
 * scaled to unit energy, so a wet gain of 1 hands back about the power it was
 * given; half of that puts the room a steady 6 dB under the track at the top of
 * the travel — drenched, with the track still plainly in front of it.
 */
const WET_MAX = 0.5;

/**
 * One room in the graph. Its response is built on the first change that makes it
 * audible, so a session that never touches the reverb never builds one, and kept
 * from then on — an `AudioBuffer` lives as long as the context it was made for.
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
		// `roomImpulse` scales the responses to unit energy itself.
		this.convolver.normalize = false;
		this.gain = context.createGain();
		input.connect(this.convolver).connect(this.gain).connect(into);
	}

	load(): void {
		this.impulse ??= buildImpulse(this.context, this.room);
		// Assigning `buffer` resets the convolver's state, and this runs on every
		// frame of a dragged slider: the guard is what carries the tail through a
		// drag.
		if (this.convolver.buffer !== this.impulse) {
			this.convolver.buffer = this.impulse;
		}
	}
}

/**
 *     input ─┬──────────────────────────────────► mix ─►
 *            ├─► small ─┐                          │
 *            └─► large ─┴─► wet ───────────────────┘
 *
 * The dry path is a bare connection, so the track reaches `mix` at full level
 * wherever the slider sits.
 */
interface ReverbGraph {
	context: AudioContext;
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
 * A room around the track, and the setting that describes it. The setting stands
 * whether or not there is a graph to apply it to; `attach` marries the two.
 */
export class Reverb implements GraphStage {
	private amount = 0;
	private graph: ReverbGraph | null = null;

	get value(): number {
		return this.amount;
	}

	/** True if the setting moved, which is what the owner reports onwards. */
	set(amount: number): boolean {
		const next = clamp(amount, 0, 1, 0);
		if (next === this.amount) return false;
		this.amount = next;
		const graph = this.graph;
		if (graph) {
			this.loadImpulses();
			this.writeLevels(graph, writeRamp(graph.context.currentTime));
		}
		return true;
	}

	attach(context: AudioContext, input: AudioNode): AudioNode {
		const graph = buildReverb(context, input);
		this.graph = graph;
		this.loadImpulses();
		// As values, so the graph opens at the current setting rather than sliding
		// there from the unity a GainNode comes up at — which on `wet` is fully wet.
		this.writeLevels(graph, writeValue);
		return graph.mix;
	}

	release(): void {
		// The responses go with the nodes: an AudioBuffer belongs to the sample
		// rate it was made at, and the next context is free to have another.
		this.graph = null;
	}

	/**
	 * Both rooms, whatever the slider reads: the morph has the far one fading in
	 * from the moment the slider leaves the near one. Zero is silent on both, so a
	 * response waits until there is something to hear.
	 */
	private loadImpulses(): void {
		const graph = this.graph;
		if (this.amount <= 0 || !graph) return;
		graph.small.load();
		graph.large.load();
	}

	/**
	 * The slider turns the space itself — `small`/`large` at constant power over
	 * independent responses, so it lengthens from a room to a hall while holding
	 * its level — while `wet` says how much of that comes back, on a quarter sine
	 * so it climbs fastest where the slider leaves zero.
	 *
	 * The trim on `mix` is the one thing the dry signal feels. The wet return is
	 * uncorrelated with what produced it, so the two add in power; dividing the bus
	 * by that holds the whole mix at the level the track arrived at, for 1 dB
	 * across the entire travel.
	 */
	private writeLevels(graph: ReverbGraph, write: ParamWriter): void {
		const turn = (this.amount * Math.PI) / 2;
		const wet = WET_MAX * Math.sin(turn);
		write(graph.mix.gain, 1 / Math.hypot(1, wet));
		write(graph.wet.gain, wet);
		write(graph.small.gain.gain, Math.cos(turn));
		write(graph.large.gain.gain, Math.sin(turn));
	}
}
