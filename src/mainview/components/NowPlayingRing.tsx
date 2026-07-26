import { cn } from "@/lib/utils";

/**
 * The sidebar's player indicator: a purple ring floating around the cover of
 * the playlist whose collection the queue mirrors — a faint closed ring
 * while paused, plus a bright arc orbiting the cover while audio runs (all
 * the CSS lives in index.css under `.np-ring`). Rendered inside the cover's
 * `relative` wrapper, which it overhangs by 4px on every side.
 *
 * Decorative only — the row's name tint already carries the state — so it's
 * hidden from assistive tech; prefers-reduced-motion drops the orbit and
 * keeps the static ring.
 */
export function NowPlayingRing({ spinning }: { spinning: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={cn("np-ring", spinning && "np-ring--spinning")}
		/>
	);
}
