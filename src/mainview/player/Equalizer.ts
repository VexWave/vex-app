/**
 * Centre frequencies of the bands, an octave apart from 31 Hz up — the ten-band
 * layout a graphic equalizer wears everywhere. It is also the order a curve is
 * stored and read in: one gain per entry here, so an array of ten numbers needs
 * no keys to say which slider it came from.
 */
export const EQ_BANDS = [
	31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
] as const;

/** How far a band may be pushed either way, in dB. */
export const EQ_GAIN_LIMIT_DB = 12;
/** How far the preamp may be pushed either way, in dB. */
export const EQ_PREAMP_LIMIT_DB = 12;
/** Resolution of a fader, in dB — what one arrow key moves. */
export const EQ_GAIN_STEP_DB = 0.5;

/**
 * Q of the peaking bands: sqrt(2^n)/(2^n − 1) at n = 1 octave, which is the
 * width that has neighbouring bands meet at their half-power points. Wider and
 * two adjacent faders fight over the same frequencies; narrower and the gaps
 * between them stay untouched however far either one is pushed.
 */
const BAND_Q = Math.SQRT2;

/**
 * Time constant of every parameter move, in seconds. A gain written straight
 * onto a running graph steps, and a step in a filter coefficient is a click; an
 * exponential approach this short has arrived within about 50 ms, soon enough to
 * belong to the fader that asked for it and gradual enough to stay silent.
 */
const RAMP_TAU = 0.01;

export interface EqualizerState {
	enabled: boolean;
	/** One gain per entry of `EQ_BANDS`, in dB. */
	gains: readonly number[];
	preampDb: number;
}

/**
 * Into range, and anything that is not a number to 0 dB — which is no change at
 * all, the one value that is safe to land on without being asked for.
 */
function clamp(value: number, limit: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(Math.max(value, -limit), limit);
}

/**
 * The ten-band equalizer sitting in the playback graph, and the settings that
 * describe it.
 *
 * It holds those settings whether or not there is a graph to apply them to:
 * `AudioPlayer` builds the audio nodes on the first playback (see
 * `ensureAnalyser`), while the settings view can be opened and dragged around
 * before anything has ever played. `attach` is what marries the two, and every
 * change lands on the nodes from then on.
 *
 * A store rather than an event emitter, exposing one immutable snapshot for
 * `useSyncExternalStore` — the same contract `PlayerController` offers, but its
 * own, so dragging a fader doesn't churn the player's snapshot and re-render
 * every track row in the app.
 */
export class Equalizer {
	private subscribers = new Set<() => void>();
	private enabled = true;
	private gains: number[] = EQ_BANDS.map(() => 0);
	private preampDb = 0;
	private snapshot: EqualizerState;

	/** Null until the playback graph is built; the settings stand without it. */
	private context: AudioContext | null = null;
	private preampNode: GainNode | null = null;
	private filters: BiquadFilterNode[] = [];

	constructor() {
		this.snapshot = this.buildSnapshot();
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): EqualizerState => this.snapshot;

	// --- settings ---

	/**
	 * Bypass the whole thing, keeping the curve. This is the comparison an
	 * equalizer's switch is for — what it was doing has to still be there when it
	 * comes back on.
	 */
	setEnabled(enabled: boolean): void {
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		this.commit();
	}

	setBandGain(index: number, db: number): void {
		if (index < 0 || index >= this.gains.length) return;
		const gain = clamp(db, EQ_GAIN_LIMIT_DB);
		if (this.gains[index] === gain) return;
		// Replaced rather than written into: the snapshot hands this array
		// straight to React, which compares it by identity.
		this.gains = this.gains.map((current, i) => (i === index ? gain : current));
		this.commit();
	}

	/**
	 * Put stored settings back, as one commit rather than one per field: a
	 * subscriber cannot catch the restore half applied, and cannot hand it back
	 * to storage as three separate changes either. A null field is a key that was
	 * never written or failed validation, and leaves the default standing.
	 */
	restore(stored: {
		enabled: boolean | null;
		gains: readonly number[] | null;
		preampDb: number | null;
	}): void {
		if (stored.enabled !== null) this.enabled = stored.enabled;
		if (stored.gains !== null) {
			const gains = stored.gains;
			this.gains = this.gains.map((current, index) =>
				clamp(gains[index] ?? current, EQ_GAIN_LIMIT_DB),
			);
		}
		if (stored.preampDb !== null) {
			this.preampDb = clamp(stored.preampDb, EQ_PREAMP_LIMIT_DB);
		}
		this.commit();
	}

	/** Back to flat: every band and the preamp at 0 dB. */
	reset(): void {
		if (this.preampDb === 0 && this.gains.every((gain) => gain === 0)) return;
		this.gains = this.gains.map(() => 0);
		this.preampDb = 0;
		this.commit();
	}

	setPreamp(db: number): void {
		const preampDb = clamp(db, EQ_PREAMP_LIMIT_DB);
		if (preampDb === this.preampDb) return;
		this.preampDb = preampDb;
		this.commit();
	}

	// --- the audio graph ---

	/**
	 * Build the chain, hang it off `input`, and hand back the node the rest of
	 * the graph carries on from. Called once, while the playback graph is being
	 * assembled: the nodes come up flat and ease into the current settings on the
	 * same ramp every later change takes.
	 */
	attach(context: AudioContext, input: AudioNode): AudioNode {
		this.context = context;
		this.preampNode = context.createGain();
		this.filters = EQ_BANDS.map((hz, index) => {
			const filter = context.createBiquadFilter();
			// Shelves at the two ends, so the outermost faders lift or drop
			// everything beyond them rather than a bump in the middle of nowhere
			// with the last octave left behind. A shelf takes no Q — the spec
			// ignores it — which is why only the peaking bands set one.
			if (index === 0) {
				filter.type = "lowshelf";
			} else if (index === EQ_BANDS.length - 1) {
				filter.type = "highshelf";
			} else {
				filter.type = "peaking";
				filter.Q.value = BAND_Q;
			}
			filter.frequency.value = hz;
			return filter;
		});

		input.connect(this.preampNode);
		const output = this.filters.reduce<AudioNode>((previous, filter) => {
			previous.connect(filter);
			return filter;
		}, this.preampNode);
		this.apply();
		return output;
	}

	/**
	 * Forget the nodes, for a graph that failed to come up. The settings survive;
	 * only the chain they were being written to is gone.
	 */
	release(): void {
		this.context = null;
		this.preampNode = null;
		this.filters = [];
	}

	// --- internals ---

	/**
	 * Land a change, on the nodes and then on the subscribers. Every setter ends
	 * here, so a change cannot reach the audio without reaching the UI that
	 * describes it, or the other way about.
	 */
	private commit(): void {
		this.apply();
		this.snapshot = this.buildSnapshot();
		this.subscribers.forEach((notify) => notify());
	}

	/**
	 * Push the settings onto the nodes, or onto nothing while there are none.
	 *
	 * Bypass is a flat curve at unity gain rather than a chain lifted out of the
	 * graph: a peaking filter at 0 dB is transparent, so the two are the same
	 * sound, and re-routing a live graph clicks where a ramped parameter doesn't.
	 */
	private apply(): void {
		const context = this.context;
		if (!context || !this.preampNode) return;
		const at = context.currentTime;
		this.preampNode.gain.setTargetAtTime(
			this.enabled ? 10 ** (this.preampDb / 20) : 1,
			at,
			RAMP_TAU,
		);
		this.filters.forEach((filter, index) => {
			filter.gain.setTargetAtTime(
				this.enabled ? this.gains[index] : 0,
				at,
				RAMP_TAU,
			);
		});
	}

	private buildSnapshot(): EqualizerState {
		return {
			enabled: this.enabled,
			gains: this.gains,
			preampDb: this.preampDb,
		};
	}
}
