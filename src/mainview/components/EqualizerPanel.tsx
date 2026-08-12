import type { CSSProperties } from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { Group, Toggle } from "@/components/SettingsControls";
import { Button } from "@/components/ui/button";
import { SliderThumb } from "@/components/ui/slider";
import { useEqualizer } from "@/hooks/useEqualizer";
import { cn } from "@/lib/utils";
import {
	EQ_BANDS,
	EQ_GAIN_LIMIT_DB,
	EQ_GAIN_STEP_DB,
} from "@/player/Equalizer";

/**
 * The equalizer, as a bank of ten faders with the curve they describe drawn
 * behind them.
 *
 * It wears the settings view's own panel (`SettingsControls`) and borrows the
 * shared slider's thumb, so it reads as a settings group rather than as an
 * instrument bolted into one. What it moves is live: the faders are the
 * gains on the filters in the playback graph, and a change is heard on the track
 * already playing.
 *
 * The switch in the panel's header governs everything below it. Off is a
 * bypass, not a reset — the curve stays where it was set, which is what makes
 * the switch an A/B against the untouched track — so the controls it has taken
 * out of the signal path are disabled rather than cleared.
 */
export function EqualizerPanel() {
	const { state, equalizer } = useEqualizer();
	const off = !state.enabled;
	const flat = state.gains.every((gain) => gain === 0);

	return (
		<Group
			title="Equalizer"
			description="Ten bands from deep bass up to the top of the treble."
			action={(labelling) => (
				<div className="flex items-center gap-2">
					{/* The one way back to flat, so a curve dragged somewhere odd
					    doesn't have to be dragged back band by band. */}
					<Button
						variant="ghost"
						size="sm"
						disabled={off || flat}
						onClick={() => equalizer.reset()}
						className="text-muted-foreground hover:text-foreground"
					>
						Reset
					</Button>
					<Toggle
						checked={state.enabled}
						onChange={(next) => equalizer.setEnabled(next)}
						{...labelling}
					/>
				</div>
			)}
		>
			<Bank
				gains={state.gains}
				disabled={off}
				onChange={(index, db) => equalizer.setBandGain(index, db)}
			/>
		</Group>
	);
}

/**
 * One column per band, shared by the three rows of the bank so that a reading,
 * a fader and a label cannot drift out of line — and read off `EQ_BANDS`, so a
 * band added there arrives with a column of its own.
 */
const COLUMNS: CSSProperties = {
	gridTemplateColumns: `repeat(${EQ_BANDS.length}, minmax(0, 1fr))`,
};

/**
 * The bank: the faders, with each band's reading above it and its frequency
 * below, over the curve they describe.
 */
function Bank({
	gains,
	disabled,
	onChange,
}: {
	gains: readonly number[];
	disabled: boolean;
	onChange: (index: number, db: number) => void;
}) {
	return (
		<div
			className={cn(
				"flex flex-col gap-2.5 px-4 py-4 transition-opacity",
				disabled && "opacity-40",
			)}
		>
			<div className="grid" style={COLUMNS}>
				{EQ_BANDS.map((hz, index) => (
					<span
						key={hz}
						className={cn(
							"text-center text-[11px] leading-none tabular-nums",
							gains[index] === 0
								? "text-muted-foreground/40"
								: "text-foreground",
						)}
					>
						{formatDb(gains[index])}
					</span>
				))}
			</div>

			<div className="relative h-36">
				<Curve gains={gains} />
				{/* Positioned, and after the curve, so the faders paint over it
				    without either of them needing a z-index. */}
				<div className="relative grid h-full" style={COLUMNS}>
					{EQ_BANDS.map((hz, index) => (
						<Fader
							key={hz}
							value={gains[index]}
							label={`${hz} Hz band`}
							disabled={disabled}
							onChange={(db) => onChange(index, db)}
						/>
					))}
				</div>
			</div>

			<div className="grid" style={COLUMNS}>
				{EQ_BANDS.map((hz) => (
					<span
						key={hz}
						className="text-center text-[11px] leading-none text-muted-foreground"
					>
						{formatHz(hz)}
					</span>
				))}
			</div>
		</div>
	);
}

/**
 * One band's fader, reading zero at its middle. Radix drives it, for the pointer
 * and keyboard handling and the slider semantics, and it borrows `ui/slider`'s
 * thumb — but it draws its own fill, because a gain is a cut as readily as a
 * boost and so the fill runs from the 0 dB line out to the thumb, where the
 * shared one's runs from the minimum.
 */
function Fader({
	value,
	label,
	disabled,
	onChange,
}: {
	value: number;
	label: string;
	disabled: boolean;
	onChange: (db: number) => void;
}) {
	// Where the thumb's centre sits, as a fraction of its travel from the low end
	// — and, since the thumb stands on its own value, of the track as well.
	const fraction = (value + EQ_GAIN_LIMIT_DB) / (EQ_GAIN_LIMIT_DB * 2);
	const percent = (travelled: number) => `${(travelled * 100).toFixed(4)}%`;
	// Out of the middle towards the thumb: a boost fills up, a cut fills down.
	const fill =
		value >= 0
			? { top: percent(1 - fraction), bottom: "50%" }
			: { top: "50%", bottom: percent(fraction) };

	return (
		<SliderPrimitive.Root
			orientation="vertical"
			value={[value]}
			min={-EQ_GAIN_LIMIT_DB}
			max={EQ_GAIN_LIMIT_DB}
			step={EQ_GAIN_STEP_DB}
			disabled={disabled}
			onValueChange={([next]) => onChange(next)}
			className="relative flex h-full touch-none select-none flex-col items-center"
		>
			{/* `ui/slider`'s track, a shade quieter: ten of them stood on end carry
			    far more of it than the one horizontal bar that styling was drawn
			    for, and the fill is what should be read, not the groove. */}
			<SliderPrimitive.Track className="relative h-full w-1 overflow-hidden rounded-full bg-primary/15">
				<span
					aria-hidden="true"
					className="absolute inset-x-0 bg-primary"
					style={fill}
				/>
			</SliderPrimitive.Track>
			<SliderThumb
				aria-label={label}
				aria-valuetext={`${formatDb(value)} decibels`}
			/>
		</SliderPrimitive.Root>
	);
}

/**
 * The curve behind the faders, over the 0 dB line it is read against.
 *
 * It interpolates where the ten faders stand; it is not the chain's measured
 * transfer function. What it is for is the shape — that this is a smile, or a
 * scoop of the mids — and for that a spline through the points is both honest
 * enough and readable with nothing playing, which a response measured off the
 * filters would not be.
 */
function Curve({ gains }: { gains: readonly number[] }) {
	const points = [
		// Flat approaches to either edge, so the curve spans the bank rather than
		// starting and stopping over the outermost faders.
		{ x: 0, y: heightOf(gains[0]) },
		...gains.map((gain, index) => ({
			x: ((index + 0.5) / gains.length) * 100,
			y: heightOf(gain),
		})),
		{ x: 100, y: heightOf(gains[gains.length - 1]) },
	];

	return (
		<div className="absolute inset-0">
			<div className="absolute inset-x-0 top-1/2 border-t border-border" />
			<svg
				aria-hidden="true"
				className="absolute inset-0 h-full w-full"
				viewBox="0 0 100 100"
				preserveAspectRatio="none"
			>
				{/* A line and no fill under it: the ten faders already answer "how
				    much" in their own filled tracks, and an area laid over those
				    turns a curve that is mostly one side of zero into a slab. */}
				<path
					d={smoothPath(points)}
					fill="none"
					strokeWidth={1.5}
					strokeLinecap="round"
					// The viewBox is stretched to the bank's shape — far wider than it
					// is tall — and would stretch the stroke with it: thin where the
					// curve runs flat, thick where it climbs.
					vectorEffect="non-scaling-stroke"
					className="stroke-primary/50"
				/>
			</svg>
		</div>
	);
}

/** A gain as its height in the curve's box, where 0 dB is the middle. */
function heightOf(db: number): number {
	return 50 - (db / EQ_GAIN_LIMIT_DB) * 50;
}

/**
 * A Catmull-Rom spline through the points, as cubic béziers: each end's tangent
 * is a sixth of the span between that point's two neighbours, which is the
 * curve's control point written in the only form a path accepts.
 */
function smoothPath(points: { x: number; y: number }[]): string {
	const at = (value: number) => value.toFixed(2);
	// A control point pulled outside the box would take the curve with it, into
	// the clip at the box's edge — a flat spot exactly where the fader is at its
	// most extreme, which is the least convincing place to have one.
	const inside = (y: number) => at(Math.min(100, Math.max(0, y)));

	let path = `M ${at(points[0].x)} ${at(points[0].y)}`;
	for (let index = 0; index < points.length - 1; index++) {
		const previous = points[index - 1] ?? points[index];
		const from = points[index];
		const to = points[index + 1];
		const next = points[index + 2] ?? to;
		const firstX = at(from.x + (to.x - previous.x) / 6);
		const firstY = inside(from.y + (to.y - previous.y) / 6);
		const secondX = at(to.x - (next.x - from.x) / 6);
		const secondY = inside(to.y - (next.y - from.y) / 6);
		path += ` C ${firstX} ${firstY}, ${secondX} ${secondY}, ${at(to.x)} ${at(to.y)}`;
	}
	return path;
}

/** A gain as it is read off a fader: "+3", "-1.5", "0". */
function formatDb(db: number): string {
	const value = Number.isInteger(db) ? String(db) : db.toFixed(1);
	return db > 0 ? `+${value}` : value;
}

/** A band's centre frequency, in Hz: "125", "1k". */
function formatHz(hz: number): string {
	return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}
