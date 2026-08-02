import { navigationService } from "@/api/NavigationService";
import { SECTIONS, SECTION_ORDER } from "@/components/Sections";
import { useNavigation } from "@/hooks/useNavigation";
import { cn } from "@/lib/utils";
import type { SectionName } from "@/api/NavigationService";

/**
 * The app's sides in one switch, centred in the app bar: a segment each, in a
 * groove with a single raised pill sliding between them — the same
 * recessed-track-and-raised-tile language as the logo tile beside it, so the
 * control belongs to the bar rather than sitting on top of it.
 *
 * Drawn entirely from `SECTIONS`: its segments, their order, the pill's width and
 * where it slides to. A section added to that table appears here already working.
 *
 * A `role="group"` of pressed buttons rather than a `role="tablist"`: tab
 * semantics promise that arrow keys move between the tabs, and the main area is
 * no tabpanel either — a section can have a whole sidebar navigating within it.
 * The same call the platform toggle inside Discover makes.
 *
 * A segment is lit for *every* view in its section, not just the one it opens on,
 * so exactly one of them is always lit and the switch never looks half-off.
 */
export function ViewSwitch() {
	const { section } = useNavigation();

	return (
		// The groove is a black wash and an inset shadow rather than a darker token:
		// the app bar is already within a couple of percent of `background`, so
		// nothing in the palette can read as *cut into* it — but low-alpha black
		// darkens whatever it is over, which is what a recess does in either theme.
		// Equal `1fr` tracks in an auto-width box: every segment takes the width of
		// the longest label, so the pill is one plain fraction of the whole. The
		// width itself is held by the app bar, which gives this an `auto` track.
		<div
			role="group"
			aria-label="Where to browse"
			className="relative grid rounded-full bg-black/30 p-1 shadow-[inset_0_1px_2px_rgb(0_0_0/0.55)] ring-1 ring-inset ring-foreground/[0.06]"
			style={{
				gridTemplateColumns: `repeat(${SECTION_ORDER.length}, minmax(0, 1fr))`,
			}}
		>
			<Pill index={SECTION_ORDER.indexOf(section)} />
			{SECTION_ORDER.map((name) => (
				<Segment key={name} name={name} active={name === section} />
			))}
		</div>
	);
}

/**
 * One pill that slides, rather than a background lit per segment: the switch then
 * shows the sides as one place the selection moves through.
 *
 * `inset-1` makes the wrapper exactly the track's content area, so the pill is a
 * plain fraction of something — a width of 1/n and a shift of whole multiples of
 * itself land it on any segment with nothing to measure and no padding to
 * subtract. Both are inline styles because they follow the number of sections,
 * which Tailwind can only generate classes for if it can read it in the source.
 */
function Pill({ index }: { index: number }) {
	const share = `${100 / SECTION_ORDER.length}%`;
	return (
		<span aria-hidden="true" className="pointer-events-none absolute inset-1">
			{/* Lit from above like the logo tile beside it: the gradient falls off
			    downwards, the inset ring draws a bright top edge against the groove,
			    and the drop shadow puts the pill in front of it. */}
			<span
				className="block h-full rounded-full bg-gradient-to-b from-muted to-muted/60 shadow-lg shadow-black/50 ring-1 ring-inset ring-foreground/15 transition-transform duration-300 ease-out motion-reduce:transition-none"
				style={{ width: share, transform: `translateX(${index * 100}%)` }}
			/>
		</span>
	);
}

function Segment({ name, active }: { name: SectionName; active: boolean }) {
	const { label, Icon } = SECTIONS[name];
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={() => navigationService.showSection(name)}
			// `relative` for one reason: the sliding pill is positioned and would
			// otherwise paint over the label it is supposed to sit behind.
			className={cn(
				// One weight for every segment, never a bolder selected label: the
				// container is an `auto` track sized by its longest label, so a weight
				// that changed with the selection would resize the switch — and shift
				// the centre of the app bar — on every press. Colour and the pill carry
				// the state.
				"relative flex h-8 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				// An unselected side is dimmed past `muted-foreground`, bright enough at
				// rest to read as a selection you could make — and brightens only
				// partway under the pointer, since full `foreground` is the selected
				// label's own colour and would answer a hover by looking chosen.
				active
					? "text-foreground"
					: "text-muted-foreground/70 hover:text-foreground/80",
			)}
		>
			{/* The selected glyph takes `primary`, the same mark the sidebar puts on
			    its active item; the others inherit their label's colour. */}
			<Icon
				className={cn("h-4 w-4 shrink-0 transition-colors", active && "text-primary")}
			/>
			{label}
		</button>
	);
}
