/**
 * The vocabulary the playback graph's stages share. Its own module because both
 * stages need it and neither owns it — the same reason `playerBarChrome` exists
 * beside the components that share it.
 */

/**
 * A stage in the chain `AudioPlayer` builds on the first playback.
 *
 * `attach` hangs the stage's nodes off `input` and returns the node the next
 * stage carries on from, so stages compose in the order they are attached.
 * `release` forgets those nodes for a graph that failed to come up — the
 * settings survive, only the chain they were being written to is gone, and the
 * nodes themselves are severed by disconnecting the source they hang off.
 */
export interface GraphStage {
	attach(context: AudioContext, input: AudioNode): AudioNode;
	release(): void;
}

/**
 * Time constant of a move a control asked for, in seconds, and the default for
 * every move. An exponential approach this short has arrived within about 50 ms —
 * soon enough to belong to the control that asked for it, gradual enough to stay
 * silent.
 */
const RAMP_TAU = 0.01;

/**
 * Ease a parameter to a value, rather than writing it. A value written straight
 * onto a running graph steps, and a step in a gain or a filter coefficient is a
 * click.
 *
 * It is an approach and not an arrival: `setTargetAtTime` closes on its target
 * asymptotically, so a bypassed band settles to 0 dB without ever being exactly
 * 0 dB. Nothing here reads a parameter back, which is what makes that fine.
 *
 * A longer `tau` is for a move nobody asked for, which should not be noticed
 * arriving at all.
 */
export function easeParam(
	param: AudioParam,
	value: number,
	at: number,
	tau = RAMP_TAU,
): void {
	param.setTargetAtTime(value, at, tau);
}

/**
 * How a stage's levels reach its parameters. A stage maps its setting onto its
 * gains in one place and takes this, so the graph it builds and the graph it
 * later adjusts cannot disagree about what a setting means.
 */
export type ParamWriter = (param: AudioParam, value: number) => void;

/** For a graph being built, which has nothing to glide from. */
export const writeValue: ParamWriter = (param, value) => {
	param.value = value;
};

/**
 * For a graph already running. `at` is bound once so every parameter in the move
 * shares one reference time — an `AudioParam` cannot name its own context.
 */
export const writeRamp =
	(at: number): ParamWriter =>
	(param, value) =>
		easeParam(param, value, at);
