import { useEffect, useRef } from "react";
import type { PlayerController } from "@/player/PlayerController";

/** Bass carries the drops; the upper band lets kicks and snares register. */
const BASS_HZ = 160;
const PUNCH_LOW_HZ = 1500;
const PUNCH_HIGH_HZ = 8000;
/** Share of the level the bass band accounts for. */
const BASS_WEIGHT = 0.7;

/**
 * Loudness is logarithmic, so the whole mapping works in decibels: this is the
 * range below the recent peak that spans dark-to-full-brightness. Wider reads
 * calmer, narrower makes quiet passages drop off a cliff.
 */
const RANGE_DB = 14;
/** The peak reference follows a rise instantly and falls at this rate. */
const PEAK_FALL_DB_PER_SEC = 3;
/**
 * Floor under that reference. Without it the peak keeps sliding down through a
 * quiet passage until the noise floor itself reads as full brightness — the
 * usual way an auto-gain scheme ends up pumping.
 */
const MIN_PEAK_DB = -60;
/** Envelope: fast enough to catch a kick, slow enough not to flicker. */
const ATTACK_TAU = 0.05;
const RELEASE_TAU = 0.22;
/** Above 1 keeps quiet passages dark so the loud hits carry the movement. */
const CURVE = 1.6;
/** What full scale is worth, on top of the resting 1.0. */
const BRIGHTNESS_GAIN = 0.6;
const SATURATION_GAIN = 0.4;
/** Below this the glow is off and the filter comes off with it. */
const SETTLED = 0.004;

/** Mean linear amplitude across a bin range of dB-valued spectrum data. */
function bandLevel(data: Float32Array, start: number, end: number): number {
	let sum = 0;
	for (let bin = start; bin < end; bin++) sum += 10 ** (data[bin] / 20);
	return sum / Math.max(1, end - start);
}

/**
 * Drives brightness from how loud the track currently is, for the element the
 * returned ref is attached to. A drop or a kick pushes it up, a quiet bar lets
 * it fall back — it follows the music's envelope rather than trying to decide
 * where the beats are.
 *
 * Two things make that read as synced. The level is measured in decibels
 * against a *recent peak* rather than an absolute scale, so it uses the full
 * brightness range at any volume and on any master level; and it is smoothed
 * with a fast attack and a slower release, the way an audio envelope follower
 * is, so transients arrive sharp but never strobe.
 *
 * The filter is written straight to the node's style. Putting it through React
 * state would re-render the whole player bar on every animation frame, and the
 * value it carries is not state anything else can read.
 */
export function useAudioGlow(controller: PlayerController, isPlaying: boolean) {
	const nodeRef = useRef<HTMLDivElement | null>(null);
	const frameRef = useRef<number | null>(null);
	const playingRef = useRef(isPlaying);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const dataRef = useRef(new Float32Array(0));
	const bandsRef = useRef({ bass: 1, punchStart: 1, punchEnd: 1 });
	const peakDbRef = useRef(MIN_PEAK_DB);
	/** False until the first frame seeds the peak from real audio. */
	const primedRef = useRef(false);
	const levelRef = useRef(0);
	const lastFrameRef = useRef(0);

	useEffect(() => {
		playingRef.current = isPlaying;
		// A loop still easing the glow back down simply carries on.
		if (!isPlaying || frameRef.current !== null) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

		lastFrameRef.current = performance.now();
		primedRef.current = false;

		const tick = () => {
			// The node comes and goes with the artwork — a track without a cover
			// has nothing to light up. The loop keeps running regardless, because
			// only a play/pause restarts it and the next track may well have one.
			const node = nodeRef.current;
			const analyser = controller.analyser;
			if (analyser !== analyserRef.current) {
				analyserRef.current = analyser;
				dataRef.current = new Float32Array(analyser?.frequencyBinCount ?? 0);
				if (analyser) {
					const bins = analyser.frequencyBinCount;
					const nyquist = analyser.context.sampleRate / 2;
					// From bin 1 up: bin 0 is DC offset, not sound.
					const binFor = (hz: number) =>
						Math.min(bins, Math.max(1, Math.round((hz / nyquist) * bins)));
					bandsRef.current = {
						bass: binFor(BASS_HZ),
						punchStart: binFor(PUNCH_LOW_HZ),
						punchEnd: binFor(PUNCH_HIGH_HZ),
					};
				}
			}

			const now = performance.now();
			// Clamped: a backgrounded window resumes with a huge gap, which would
			// otherwise collapse the peak reference in a single step.
			const dt = Math.min(0.1, (now - lastFrameRef.current) / 1000);
			lastFrameRef.current = now;

			let target = 0;
			if (analyser && playingRef.current) {
				analyser.getFloatFrequencyData(dataRef.current);
				const { bass, punchStart, punchEnd } = bandsRef.current;
				const energy =
					BASS_WEIGHT * bandLevel(dataRef.current, 1, bass) +
					(1 - BASS_WEIGHT) *
						bandLevel(dataRef.current, punchStart, punchEnd);
				// +epsilon: silent bins are -Infinity dB, so the mean can be a
				// true zero and log10(0) would poison everything downstream.
				const db = 20 * Math.log10(energy + 1e-12);

				if (!primedRef.current) {
					peakDbRef.current = Math.max(db, MIN_PEAK_DB);
					primedRef.current = true;
				}
				peakDbRef.current = Math.max(
					db,
					MIN_PEAK_DB,
					peakDbRef.current - PEAK_FALL_DB_PER_SEC * dt,
				);

				const floor = peakDbRef.current - RANGE_DB;
				const scaled = (db - floor) / RANGE_DB;
				target = Math.min(1, Math.max(0, scaled)) ** CURVE;
			}

			// Asymmetric smoothing is what makes a hit land and then bloom out,
			// instead of the level jittering with every frame of the spectrum.
			const previous = levelRef.current;
			const tau = target > previous ? ATTACK_TAU : RELEASE_TAU;
			const level =
				previous + (target - previous) * (1 - Math.exp(-dt / tau));
			levelRef.current = level;

			const done = level < SETTLED;
			// Empty rather than the identity filter, so a resting bar carries no
			// filter at all — and with it no needless compositing layer.
			const filter = done
				? ""
				: `brightness(${1 + level * BRIGHTNESS_GAIN}) saturate(${
						1 + level * SATURATION_GAIN
					})`;
			// Compared first because a silent passage would otherwise rewrite the
			// same empty string every frame. Reading an inline style is cheap —
			// it's the declaration, not the computed value, so nothing reflows.
			if (node && node.style.filter !== filter) node.style.filter = filter;

			if (!playingRef.current && done) {
				frameRef.current = null;
				return;
			}
			frameRef.current = requestAnimationFrame(tick);
		};

		frameRef.current = requestAnimationFrame(tick);
	}, [isPlaying, controller]);

	useEffect(
		() => () => {
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
		},
		[],
	);

	return nodeRef;
}
