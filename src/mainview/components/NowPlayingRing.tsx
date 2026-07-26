import { cn } from "@/lib/utils";

/**
 * The player indicator worn by the artwork of whichever collection the queue
 * mirrors — a playlist in the sidebar, an artist in the artists grid: a faint
 * closed purple ring while it merely owns the queue, plus two glowing arcs
 * orbiting opposite each other while audio runs (all the CSS lives in
 * index.css under `.np-ring`). Two stacked layers so each state fades in and
 * out instead of popping. Render it unconditionally inside the artwork's
 * `relative` wrapper (which it overhangs on every side): an element that
 * unmounts can't fade out, and the idle rings are invisible with their
 * animation paused, so the always-on mount is free.
 *
 * Decorative only — the name tint beside it already carries the state — so
 * it's hidden from assistive tech; prefers-reduced-motion swaps the orbit
 * for a brightened closed ring.
 */
export function NowPlayingRing({
	ownsQueue,
	playing,
	round,
}: {
	ownsQueue: boolean;
	playing: boolean;
	/** Follow a circular avatar instead of a rounded square. */
	round?: boolean;
}) {
	return (
		<>
			<span
				aria-hidden="true"
				className={cn(
					"np-ring np-ring--base",
					round && "np-ring--round",
					ownsQueue && "np-ring--on",
				)}
			/>
			<span
				aria-hidden="true"
				className={cn(
					"np-ring np-ring--arc",
					round && "np-ring--round",
					playing && "np-ring--on",
				)}
			/>
		</>
	);
}
