import { cn } from "@/lib/utils";

/**
 * The sidebar's player indicator: a purple ring floating around the cover
 * of the playlist whose collection the queue mirrors — a faint closed ring
 * while it merely owns the queue, plus two glowing arcs orbiting opposite
 * each other while audio runs (all the CSS lives in index.css under
 * `.np-ring`). Two stacked layers so each state fades in and out instead
 * of popping. Render it unconditionally inside the cover's `relative`
 * wrapper (which it overhangs on every side): an element that unmounts
 * can't fade out, and the idle rings are invisible with their animation
 * paused, so the always-on mount is free.
 *
 * Decorative only — the row's name tint already carries the state — so
 * it's hidden from assistive tech; prefers-reduced-motion swaps the orbit
 * for a brightened closed ring.
 */
export function NowPlayingRing({
	ownsQueue,
	playing,
}: {
	ownsQueue: boolean;
	playing: boolean;
}) {
	return (
		<>
			<span
				aria-hidden="true"
				className={cn("np-ring np-ring--base", ownsQueue && "np-ring--on")}
			/>
			<span
				aria-hidden="true"
				className={cn("np-ring np-ring--arc", playing && "np-ring--on")}
			/>
		</>
	);
}
