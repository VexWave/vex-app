import { navigationService } from "@/api/NavigationService";
import { SECTIONS, SECTION_ORDER } from "@/components/Sections";
import { useNavigation } from "@/hooks/useNavigation";
import { cn } from "@/lib/utils";
import type { SectionName } from "@/api/NavigationService";

/**
 * The app's sides in one switch, centred in the app bar: a segment each, with a
 * single violet marker sliding between them — a lit edge along the base of the
 * chosen side and its glow rising off it into the label. Nothing encloses the
 * segments, so the switch reads as part of the bar rather than as a control
 * sitting on it.
 *
 * Drawn entirely from `SECTIONS`: its segments, their order, the marker's width
 * and where it slides to. A section added to that table appears here already
 * working.
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
		// Equal `1fr` tracks in an auto-width box: every segment takes the width of
		// the longest label, so the marker is one plain fraction of the whole. The
		// width itself is held by the app bar, which gives this an `auto` track.
		<div
			role="group"
			aria-label="Where to browse"
			className="relative grid"
			style={{
				gridTemplateColumns: `repeat(${SECTION_ORDER.length}, minmax(0, 1fr))`,
			}}
		>
			<Marker index={SECTION_ORDER.indexOf(section)} />
			{SECTION_ORDER.map((name) => (
				<Segment key={name} name={name} active={name === section} />
			))}
		</div>
	);
}

/**
 * One marker that slides, rather than a glow lit per segment: the switch then
 * shows the sides as one place the selection moves through.
 *
 * Lit from below: the radial centre sits past the base, so the bright core lands
 * on the edge and only its falloff reaches the label. The base line itself is an
 * *inset* shadow rather than a border — it paints inside the box without joining
 * the layout, leaving the gradient the marker's full height to fade over.
 *
 * Its width and offset are inline styles because they follow the number of
 * sections, which Tailwind can only generate classes for if it can read it in
 * the source.
 */
function Marker({ index }: { index: number }) {
	const share = `${100 / SECTION_ORDER.length}%`;
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-y-0 left-0 rounded-t-lg rounded-b-[2px] bg-[radial-gradient(125%_95%_at_50%_122%,hsl(var(--nav)/0.55)_0%,hsl(var(--nav)/0.16)_48%,transparent_72%)] shadow-[inset_0_-1px_0_hsl(var(--nav-edge)/0.9)] transition-transform duration-300 ease-swift motion-reduce:transition-none"
			style={{ width: share, transform: `translateX(${index * 100}%)` }}
		/>
	);
}

function Segment({ name, active }: { name: SectionName; active: boolean }) {
	const { label, Icon } = SECTIONS[name];
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={() => navigationService.showSection(name)}
			// `relative` for one reason: the sliding marker is positioned and would
			// otherwise paint over the label it is supposed to sit behind.
			className={cn(
				// One weight for every segment, never a bolder selected label: the
				// container is an `auto` track sized by its longest label, so a weight
				// that changed with the selection would resize the switch — and shift
				// the centre of the app bar — on every press. Colour and the marker
				// carry the state.
				//
				// The corners are the marker's own, so the focus ring traces the shape
				// the selection has rather than a rounder one of its own.
				"relative flex h-9 items-center justify-center gap-2 rounded-t-lg rounded-b-[2px] px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				// An unselected side is dimmed past `muted-foreground`, bright enough at
				// rest to read as a selection you could make — and brightens only
				// partway under the pointer, since full `foreground` is the selected
				// label's own colour and would answer a hover by looking chosen.
				active
					? "text-foreground"
					: "text-muted-foreground/70 hover:text-foreground/80",
			)}
		>
			{/* The unselected glyphs inherit their label's colour. */}
			<Icon
				className={cn("h-4 w-4 shrink-0 transition-colors", active && "text-nav-bright")}
			/>
			{label}
		</button>
	);
}
