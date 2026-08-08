import { cn } from "@/lib/utils";

/**
 * How a button in the player bar states itself. Its own module rather than
 * `PlayerBar`'s, because the bar's controls are split across components and one
 * importing the other would close a cycle.
 */

/**
 * Hover treatment for the bar's ghost buttons. The stock ghost variant fills
 * with an opaque `bg-accent`, which lands as a flat grey patch on top of the
 * cover backdrop. A translucent tint of the foreground colour lifts the button
 * out of whatever is behind it instead, and stays theme-correct: near-white on
 * the dark theme, near-black on the light one.
 */
export const BAR_GHOST =
	"hover:bg-foreground/10 hover:text-foreground active:bg-foreground/15";

/**
 * Shuffle, repeat and the effects panel are all mode toggles, so they state
 * themselves the same way: lit in the accent colour while engaged, dimmed back
 * into the bar while off.
 */
export const modeToggle = (engaged: boolean): string =>
	cn(BAR_GHOST, engaged ? "text-primary" : "text-muted-foreground");
