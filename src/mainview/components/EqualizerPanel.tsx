import type { CSSProperties } from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { Group, SettingRow, Toggle } from "@/components/SettingsControls";
import { Button } from "@/components/ui/button";
import { useEqualizer } from "@/hooks/useEqualizer";
import { cn } from "@/lib/utils";
import {
	EQ_BANDS,
	EQ_GAIN_LIMIT_DB,
	EQ_GAIN_STEP_DB,
	EQ_PREAMP_LIMIT_DB,
} from "@/player/Equalizer";

/**
 * The thumb, in px. A slider's thumb travels between half of itself from either
 * end of its track, so everything drawn to line up with the thumbs — the fill
 * running up to one, the curve through all ten — carries that same half-thumb
 * inset. The one number they all read from; it is `ui/slider`'s `h-4 w-4`.
 */
const THUMB_PX = 16;

/**
 * The equalizer, as a bank of ten faders with the curve they describe drawn
 * behind them.
 *
 * It wears the settings view's own panel and rows (`SettingsControls`) and
 * borrows the shared slider's thumb, so it reads as a settings group rather than
 * as an instrument bolted into one. What it moves is live: the faders are the
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
	const flat = state.preampDb === 0 && state.gains.every((gain) => gain === 0);

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

			<SettingRow
				label="Preamp"
				hint="The level going into the bands. Pull it down when boosted bass starts to break up."
				// The same fader as a band, lying on its side, because it is the same
				// kind of number: nothing at the middle, and as much of a cut below it
				// as a boost above. It names itself the way the bands do, so the row's
				// ids go unused here (see SettingRow).
				control={() => (
					<div
						className={cn(
							"flex w-52 items-center gap-3 transition-opacity",
							off && "opacity-40",
						)}
					>
						<Fader
							orientation="horizontal"
							value={state.preampDb}
							limitDb={EQ_PREAMP_LIMIT_DB}
							label="Preamp"
							disabled={off}
							onChange={(db) => equalizer.setPreamp(db)}
						/>
						<span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
							{formatDb(state.preampDb)} dB
						</span>
					</div>
				)}
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
							orientation="vertical"
							value={gains[index]}
							limitDb={EQ_GAIN_LIMIT_DB}
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
 * A fader reading zero at its middle: the ten bands, and the preamp lying on its
 * side. Radix drives it, for the pointer and keyboard handling and the slider
 * semantics, and it borrows `ui/slider`'s thumb — but it draws its own fill,
 * because a gain is a cut as readily as a boost and so the fill runs from the
 * 0 dB line out to the thumb, where the shared one's runs from the minimum.
 */
function Fader({
	orientation,
	value,
	limitDb,
	label,
	disabled,
	onChange,
}: {
	orientation: "horizontal" | "vertical";
	value: number;
	limitDb: number;
	label: string;
	disabled: boolean;
	onChange: (db: number) => void;
}) {
	const vertical = orientation === "vertical";
	// Where the thumb's centre sits, as a fraction of its travel from the low end.
	const fraction = (value + limitDb) / (limitDb * 2);
	// The distance from an end of the track to the thumb's centre. The track
	// spans the whole control while the centre only crosses the half-thumb inset
	// at each end, which is the offset the fill has to carry too if it is to meet
	// the thumb it runs to. At 0 dB it comes out as the exact middle, which is
	// where the fill's other end is pinned.
	const toThumb = (travelled: number) =>
		`calc(${THUMB_PX / 2}px + ${travelled.toFixed(4)} * (100% - ${THUMB_PX}px))`;
	const fromLow = toThumb(fraction);
	const fromHigh = toThumb(1 - fraction);
	// Out of the middle towards whichever end the thumb is on, so a boost fills
	// up (or right) and a cut fills the other way.
	const fill = vertical
		? value >= 0
			? { top: fromHigh, bottom: "50%" }
			: { top: "50%", bottom: fromLow }
		: value >= 0
			? { left: "50%", right: fromHigh }
			: { left: fromLow, right: "50%" };

	return (
		<SliderPrimitive.Root
			orientation={orientation}
			value={[value]}
			min={-limitDb}
			max={limitDb}
			step={EQ_GAIN_STEP_DB}
			disabled={disabled}
			onValueChange={([next]) => onChange(next)}
			className={cn(
				"relative flex touch-none select-none items-center",
				vertical ? "h-full flex-col" : "w-full",
			)}
		>
			{/* `ui/slider`'s track, a shade quieter: ten of them stood on end carry
			    far more of it than the one horizontal bar that styling was drawn
			    for, and the fill is what should be read, not the groove. */}
			<SliderPrimitive.Track
				className={cn(
					"relative overflow-hidden rounded-full bg-primary/15",
					vertical ? "h-full w-1" : "h-1.5 w-full",
				)}
			>
				<span
					aria-hidden="true"
					className={cn(
						"absolute bg-primary",
						vertical ? "inset-x-0" : "inset-y-0",
					)}
					style={fill}
				/>
			</SliderPrimitive.Track>
			<SliderPrimitive.Thumb
				aria-label={label}
				aria-valuetext={`${formatDb(value)} decibels`}
				style={{ height: THUMB_PX, width: THUMB_PX }}
				className="block rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
		<div
			className="absolute inset-x-0"
			style={{ top: THUMB_PX / 2, bottom: THUMB_PX / 2 }}
		>
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
