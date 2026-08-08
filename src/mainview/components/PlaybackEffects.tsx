import { memo, useId, type ReactNode } from "react";
import { Gauge, RotateCcw } from "lucide-react";
import { modeToggle } from "@/components/playerBarChrome";
import { Toggle, type Labelling } from "@/components/SettingsControls";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { useEffects } from "@/hooks/useEffects";
import { RATE_MAX, RATE_MIN, RATE_STEP } from "@/player/Effects";

/**
 * One setting in the panel: a name, what it currently reads, something to press
 * beside it, and the control it spans. Borrows `SettingsControls`' shape — the
 * label is handed to the control as `Labelling` rather than wrapped around it —
 * at the density a popover wants, where `SettingRow`'s is built for the settings
 * column.
 *
 * Every row goes through it, including the one that is only a switch, so none of
 * them can drift away from the others.
 */
function EffectRow({
	label,
	readout,
	action,
	children,
}: {
	label: string;
	readout?: string;
	action?: (labelling: Labelling) => ReactNode;
	children?: (labelling: Labelling) => ReactNode;
}) {
	const labelId = useId();
	const labelling: Labelling = { "aria-labelledby": labelId };
	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between gap-2">
				<span id={labelId} className="text-sm font-medium">
					{label}
				</span>
				<div className="flex items-center gap-1">
					{readout !== undefined && (
						<span className="text-xs tabular-nums text-muted-foreground">
							{readout}
						</span>
					)}
					{action?.(labelling)}
				</div>
			</div>
			{children?.(labelling)}
		</div>
	);
}

/**
 * The speed and reverb panel behind the player bar's gauge button.
 *
 * `memo` over no props at all, deliberately: `App` subscribes to the player, so
 * `PlayerBar` re-renders several times a second while a track runs. Taking
 * nothing from it means this subtree re-renders only when the effects themselves
 * change, and an open popover isn't rebuilt under the pointer dragging it.
 */
export const PlaybackEffects = memo(function PlaybackEffects() {
	const { state, effects } = useEffects();
	const reverbPercent = Math.round(state.reverbMix * 100);
	// One expression for both: the trigger lights when something is doing
	// something, and that is exactly when there is something to undo.
	const engaged = state.rate !== 1 || state.reverbMix > 0;

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label="Speed and reverb"
					className={modeToggle(engaged)}
				>
					<Gauge className="h-5 w-5" />
				</Button>
			</PopoverTrigger>
			{/* Above the bar and flush with its right edge, where the trigger is. */}
			<PopoverContent side="top" align="end" className="space-y-4">
				{/* A header carrying the one way back, as the settings panels do:
				    the button undoes the whole panel, so it belongs to none of the
				    rows in it. */}
				<div className="flex items-center justify-between gap-2">
					<span className="text-sm font-semibold">Effects</span>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Reset effects"
						disabled={!engaged}
						onClick={() => effects.reset()}
						className="-my-1 h-6 w-6 text-muted-foreground hover:text-foreground"
					>
						<RotateCcw className="h-3.5 w-3.5" />
					</Button>
				</div>

				<EffectRow label="Speed" readout={`${state.rate.toFixed(2)}×`}>
					{(labelling) => (
						<Slider
							value={[state.rate]}
							min={RATE_MIN}
							max={RATE_MAX}
							step={RATE_STEP}
							onValueChange={([value]) => effects.setRate(value)}
							valueText={`${state.rate.toFixed(2)} times`}
							{...labelling}
						/>
					)}
				</EffectRow>

				<EffectRow
					label="Keep pitch"
					action={(labelling) => (
						<Toggle
							checked={state.preservePitch}
							onChange={(next) => effects.setPreservePitch(next)}
							{...labelling}
						/>
					)}
				/>

				<Separator />

				<EffectRow label="Reverb" readout={`${reverbPercent}%`}>
					{(labelling) => (
						<Slider
							value={[state.reverbMix]}
							max={1}
							step={0.01}
							onValueChange={([value]) => effects.setReverbMix(value)}
							valueText={`${reverbPercent} percent`}
							{...labelling}
						/>
					)}
				</EffectRow>
			</PopoverContent>
		</Popover>
	);
});
