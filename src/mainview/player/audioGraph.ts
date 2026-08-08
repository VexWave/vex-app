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
 * Time constant of every parameter move, in seconds. An exponential approach
 * this short has arrived within about 50 ms — soon enough to belong to the
 * control that asked for it, gradual enough to stay silent.
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
 * `at` is a parameter because a caller ramping several parameters at once has to
 * give them all one reference time, and because an `AudioParam` cannot name the
 * context it belongs to.
 */
export function easeParam(param: AudioParam, value: number, at: number): void {
	param.setTargetAtTime(value, at, RAMP_TAU);
}
