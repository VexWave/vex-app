import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface HeaderActionProps extends ComponentPropsWithoutRef<"button"> {
	/** Glyph shown at rest — sized by the button's own `[&_svg]:size-4` rule. */
	icon: ReactNode;
	/** Revealed on hover/focus, and the button's accessible name at all times. */
	label: string;
}

/**
 * A header button that rests as a bare glyph and grows its label out of its
 * left edge on hover. The header row is right-aligned, so the extra width is
 * taken from the left and the glyph itself keeps its distance to the edge.
 *
 * The reveal is the 0fr→1fr grid trick rather than a width transition: it
 * animates to the label's intrinsic width without measuring anything, and the
 * collapsed label is clipped rather than hidden, so it still names the button
 * for screen readers and no parallel `aria-label` can drift out of sync.
 */
export function HeaderAction({
	icon,
	label,
	className,
	...props
}: HeaderActionProps) {
	return (
		<Button
			variant="ghost"
			// px-2.5 + a 16px glyph is a 36px square while collapsed, matching the
			// row's other controls; the label column supplies its own leading gap
			// so there is nothing to animate but the one grid track.
			className={cn(
				"group h-9 shrink-0 gap-0 rounded-lg px-2.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
				className,
			)}
			{...props}
		>
			{icon}
			<span className="grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out group-hover:grid-cols-[1fr] group-focus-visible:grid-cols-[1fr] motion-reduce:transition-none">
				<span className="overflow-hidden">
					<span className="block whitespace-nowrap pl-2 pr-0.5">{label}</span>
				</span>
			</span>
		</Button>
	);
}
