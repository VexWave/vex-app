import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One titled panel of rows. Faintly darker than the main area it sits in rather
 * than lighter: `background` is below `card` in the dark theme, so the same
 * bordered box reads as recessed here and as raised in the light one — either
 * way as a surface of its own, which a second `card` on top of `card` would not.
 *
 * `action` is a control governing the whole group, sitting in its header — the
 * one place a switch can go when what it switches is the panel rather than any
 * row in it. It takes the heading and its description as its labelling, the same
 * shape a row hands its own control. A panel whose whole setting is that switch
 * has no rows to draw, and draws none rather than an empty strip under itself.
 */
export function Group({
	title,
	description,
	action,
	children,
}: {
	title: string;
	description: string;
	action?: (labelling: Labelling) => ReactNode;
	children?: ReactNode;
}) {
	const id = useId();
	const titleId = `${id}-title`;
	const descriptionId = `${id}-description`;

	return (
		<section className="overflow-hidden rounded-lg border bg-background/40">
			<div className="flex items-center gap-6 px-4 py-3">
				<div className="min-w-0 flex-1">
					<h3 id={titleId} className="text-sm font-semibold">
						{title}
					</h3>
					<p id={descriptionId} className="mt-0.5 text-xs text-muted-foreground">
						{description}
					</p>
				</div>
				{action && (
					<div className="shrink-0">
						{action({
							"aria-labelledby": titleId,
							"aria-describedby": descriptionId,
						})}
					</div>
				)}
			</div>
			{children && <div className="divide-y border-t">{children}</div>}
		</section>
	);
}

/**
 * The aria attributes tying a control to the text beside it. Handed to the
 * control rather than wrapped around it: a `<label>` only labels a real form
 * control, and every control here is a button wearing a widget role.
 */
export interface Labelling {
	"aria-labelledby": string;
	"aria-describedby"?: string;
}

/**
 * A label, an optional line explaining it, and the control they belong to. The
 * control is optional: a row can be there to say something rather than to set
 * something, which has the same shape and nothing to draw on the right.
 *
 * The hint is drawn as one paragraph, so a hint of several lines is `span`s
 * marked `block` rather than nested paragraphs — it stays one thing for the
 * control beside it to be described by.
 */
export function SettingRow({
	label,
	hint,
	control,
}: {
	label: string;
	hint?: ReactNode;
	control?: (labelling: Labelling) => ReactNode;
}) {
	const id = useId();
	const labelId = `${id}-label`;
	const hintId = `${id}-hint`;

	return (
		<div className="flex items-center gap-6 px-4 py-3">
			<div className="min-w-0 flex-1">
				<p id={labelId} className="text-sm">
					{label}
				</p>
				{hint && (
					<p
						id={hintId}
						className="mt-0.5 text-xs leading-relaxed text-muted-foreground"
					>
						{hint}
					</p>
				)}
			</div>
			{control && (
				<div className="shrink-0">
					{control({
						"aria-labelledby": labelId,
						"aria-describedby": hint ? hintId : undefined,
					})}
				</div>
			)}
		</div>
	);
}

/**
 * An on/off switch drawn as a raised pill in the groove it slides in. The groove
 * is a black wash and an inset shadow rather than a darker token, since nothing
 * in the palette reads as *cut into* a surface but low-alpha black darkens
 * whatever it is over. On, the track lights `primary` and the knob turns to
 * `background`, so the two never approach each other's colour in either theme.
 */
export function Toggle({
	checked,
	onChange,
	...labelling
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
} & Labelling) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative h-6 w-11 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				checked
					? "bg-primary"
					: "bg-black/30 shadow-[inset_0_1px_2px_rgb(0_0_0/0.55)] ring-1 ring-inset ring-foreground/[0.06]",
			)}
			{...labelling}
		>
			{/* 2px of track showing on either side: 20px of knob and 22px of travel
			    inside 44px. */}
			<span
				aria-hidden="true"
				className={cn(
					"absolute left-0 top-1/2 block h-5 w-5 -translate-y-1/2 rounded-full shadow-lg shadow-black/50 ring-1 ring-inset transition-transform duration-200 ease-out motion-reduce:transition-none",
					checked
						? "translate-x-[22px] bg-background ring-black/10"
						: "translate-x-0.5 bg-gradient-to-b from-muted to-muted/60 ring-foreground/15",
				)}
			/>
		</button>
	);
}
