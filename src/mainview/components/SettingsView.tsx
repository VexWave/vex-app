import { useId, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

/**
 * The preferences the mockup lays out. Nothing reads them — they exist so the
 * controls have something to move.
 */
interface Draft {
	crossfadeSec: number;
	normalizeVolume: boolean;
	resumeQueue: boolean;
	downloadQuality: "best" | "256" | "128";
	thumbnailAsCover: boolean;
	skipReview: boolean;
	presence: boolean;
	presenceArtwork: boolean;
	refreshOnFocus: boolean;
	confirmDelete: boolean;
	theme: "system" | "dark" | "light";
	reduceMotion: boolean;
}

const DEFAULTS: Draft = {
	crossfadeSec: 0,
	normalizeVolume: true,
	resumeQueue: true,
	downloadQuality: "best",
	thumbnailAsCover: true,
	skipReview: false,
	presence: true,
	presenceArtwork: true,
	refreshOnFocus: false,
	confirmDelete: true,
	theme: "dark",
	reduceMotion: false,
};

/**
 * A mockup of the app's preferences: the groups and the controls are real, what
 * they change is not. It stands in its own section rather than in a dialog
 * because settings are a place to be, not an interruption — and like Discover it
 * declares no aside (see `components/Sections`), so the one column of groups is
 * centred in the window it takes rather than pushed against a sidebar.
 *
 * The draft values are component-local on purpose. A setting that did something
 * would live in a service beside the others with its key declared in
 * `lib/storage` (see `api/CLAUDE.md`); holding a mockup's values in a singleton
 * would only make them look persisted, and losing them on the way to Discover
 * and back is the honest behaviour until one of them means anything.
 */
export function SettingsView() {
	const [draft, setDraft] = useState(DEFAULTS);

	const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
		setDraft((current) => ({ ...current, [key]: value }));
	};

	return (
		<div className="flex h-full flex-col">
			{/* The same plain heading every view wears — the switch already names
			    this one in the app bar, glyph and all. */}
			<div className="flex items-center gap-3 px-4 py-2.5">
				<h2 className="shrink-0 text-sm font-semibold">Settings</h2>
			</div>
			<Separator />

			{/* Said in the view rather than only in the source: every control below
			    answers a press, which is exactly what a preference that was being
			    saved would look like. */}
			<div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
				<Info className="h-3.5 w-3.5 shrink-0" />
				<span>A mockup — these controls change nothing, and reset when you leave.</span>
			</div>

			<ScrollArea className="min-h-0 flex-1">
				{/* A measure rather than the full width: this is a column of prose and
				    controls, and the section brings no aside to take the rest. */}
				<div className="mx-auto flex max-w-2xl flex-col gap-5 p-5">
					<Group
						title="Playback"
						description="How one track gives way to the next."
					>
						<SettingRow
							label="Crossfade"
							hint="Fade the end of one track into the start of the next."
							// The readout is the label a slider needs, so this row has no
							// use for the row's ids (see SettingRow).
							control={() => (
								<div className="flex w-52 items-center gap-3">
									<Slider
										value={[draft.crossfadeSec]}
										max={12}
										step={1}
										onValueChange={([value]) => update("crossfadeSec", value)}
										aria-label="Crossfade"
									/>
									<span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
										{draft.crossfadeSec === 0 ? "Off" : `${draft.crossfadeSec}s`}
									</span>
								</div>
							)}
						/>
						<SettingRow
							label="Normalize volume"
							hint="Even out the loudness differences between tracks."
							control={(labelling) => (
								<Toggle
									checked={draft.normalizeVolume}
									onChange={(next) => update("normalizeVolume", next)}
									{...labelling}
								/>
							)}
						/>
						<SettingRow
							label="Resume the queue on launch"
							hint="Pick the queue up where it stopped the last time the app was open."
							control={(labelling) => (
								<Toggle
									checked={draft.resumeQueue}
									onChange={(next) => update("resumeQueue", next)}
									{...labelling}
								/>
							)}
						/>
					</Group>

					<Group
						title="Downloads"
						description="What happens to a track imported from a link or from Discover."
					>
						<SettingRow
							label="Audio quality"
							hint="What to ask yt-dlp for before it hands the file over."
							control={(labelling) => (
								<Choice
									value={draft.downloadQuality}
									options={[
										{ value: "best", label: "Best" },
										{ value: "256", label: "256 kbps" },
										{ value: "128", label: "128 kbps" },
									]}
									onChange={(next) => update("downloadQuality", next)}
									{...labelling}
								/>
							)}
						/>
						<SettingRow
							label="Use the platform thumbnail as cover"
							hint="Prefills the cover of the review dialog a finished download opens."
							control={(labelling) => (
								<Toggle
									checked={draft.thumbnailAsCover}
									onChange={(next) => update("thumbnailAsCover", next)}
									{...labelling}
								/>
							)}
						/>
						<SettingRow
							label="Skip the review dialog"
							hint="Send a download straight to the library instead of opening it for edits first."
							control={(labelling) => (
								<Toggle
									checked={draft.skipReview}
									onChange={(next) => update("skipReview", next)}
									{...labelling}
								/>
							)}
						/>
					</Group>

					<Group
						title="Discord"
						description="What the rich presence on your profile says."
					>
						<SettingRow
							label="Show what I'm listening to"
							hint="Sets your Discord status to the track that is playing."
							control={(labelling) => (
								<Toggle
									checked={draft.presence}
									onChange={(next) => update("presence", next)}
									{...labelling}
								/>
							)}
						/>
						<SettingRow
							label="Include the cover art"
							hint="Sends the track's artwork along with the title."
							control={(labelling) => (
								<Toggle
									checked={draft.presenceArtwork}
									onChange={(next) => update("presenceArtwork", next)}
									{...labelling}
								/>
							)}
						/>
					</Group>

					<Group
						title="Library"
						description="How the app keeps up with the server."
					>
						<SettingRow
							label="Refresh when the window comes forward"
							hint="Re-fetches tracks and artists instead of waiting for the refresh button."
							control={(labelling) => (
								<Toggle
									checked={draft.refreshOnFocus}
									onChange={(next) => update("refreshOnFocus", next)}
									{...labelling}
								/>
							)}
						/>
						<SettingRow
							label="Ask before deleting a track"
							hint="Deleting removes the track from the server, not only from this machine."
							control={(labelling) => (
								<Toggle
									checked={draft.confirmDelete}
									onChange={(next) => update("confirmDelete", next)}
									{...labelling}
								/>
							)}
						/>
					</Group>

					<Group title="Appearance" description="How the app looks and moves.">
						<SettingRow
							label="Theme"
							control={(labelling) => (
								<Choice
									value={draft.theme}
									options={[
										{ value: "system", label: "System" },
										{ value: "dark", label: "Dark" },
										{ value: "light", label: "Light" },
									]}
									onChange={(next) => update("theme", next)}
									{...labelling}
								/>
							)}
						/>
						<SettingRow
							label="Reduce motion"
							hint="Stops the orbiting now-playing ring and the fade between views."
							control={(labelling) => (
								<Toggle
									checked={draft.reduceMotion}
									onChange={(next) => update("reduceMotion", next)}
									{...labelling}
								/>
							)}
						/>
					</Group>
				</div>
			</ScrollArea>
		</div>
	);
}

/**
 * One titled panel of rows. Faintly darker than the main area it sits in rather
 * than lighter: `background` is below `card` in the dark theme, so the same
 * bordered box reads as recessed here and as raised in the light one — either
 * way as a surface of its own, which a second `card` on top of `card` would not.
 */
function Group({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<section className="overflow-hidden rounded-lg border bg-background/40">
			<div className="px-4 py-3">
				<h3 className="text-sm font-semibold">{title}</h3>
				<p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
			</div>
			<div className="divide-y border-t">{children}</div>
		</section>
	);
}

/**
 * The aria attributes tying a control to the text beside it. Handed to the
 * control rather than wrapped around it: a `<label>` only labels a real form
 * control, and every control here is a button wearing a widget role.
 */
interface Labelling {
	"aria-labelledby": string;
	"aria-describedby"?: string;
}

/** A label, an optional line explaining it, and the control they belong to. */
function SettingRow({
	label,
	hint,
	control,
}: {
	label: string;
	hint?: string;
	control: (labelling: Labelling) => ReactNode;
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
			<div className="shrink-0">
				{control({
					"aria-labelledby": labelId,
					"aria-describedby": hint ? hintId : undefined,
				})}
			</div>
		</div>
	);
}

/**
 * An on/off switch in the app bar's own language: the knob is the raised pill
 * from `ViewSwitch`, and off is the groove it slides in — a black wash and an
 * inset shadow, since nothing in the palette reads as *cut into* a surface but
 * low-alpha black darkens whatever it is over. On, the track lights `primary`
 * and the knob turns to `background`, so the two never approach each other's
 * colour in either theme.
 */
function Toggle({
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

/**
 * A short set of choices as one lit segment, the same control the platform
 * toggle in Discover is. Pressed buttons rather than radios: arrow keys don't
 * move between them, and a radio group's semantics would promise that they do.
 */
function Choice<T extends string>({
	value,
	options,
	onChange,
	...labelling
}: {
	value: T;
	options: readonly { value: T; label: string }[];
	onChange: (next: T) => void;
} & Labelling) {
	return (
		<div
			role="group"
			className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
			{...labelling}
		>
			{options.map((option) => {
				const active = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(option.value)}
						className={cn(
							"h-7 rounded px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							active
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}
