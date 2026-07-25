import {
	createContext,
	useContext,
	useId,
	useMemo,
	useState,
	type ComponentPropsWithoutRef,
	type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface HeaderActionGroupValue {
	/** `useId` of the action whose label is currently revealed, if any. */
	activeId: string | null;
	activate: (id: string) => void;
}

const HeaderActionGroupContext = createContext<HeaderActionGroupValue | null>(
	null,
);

/**
 * The row of `HeaderAction`s, and the owner of which one is expanded.
 *
 * That is group state rather than each button's own `:hover` because the row
 * is right-aligned: a label expanding takes its width from the left, so every
 * button left of it slides along. With per-button `:hover` the outgoing button
 * collapsed the moment the pointer crossed into the gap next to it — before
 * the neighbour had been entered — and the row snapped a label's width (~70px)
 * to the right, out from under the pointer. Sliding from "Add songs" towards
 * "From URL" therefore skipped it and landed on "Refresh".
 *
 * So the row remembers the last action the pointer entered and only forgets it
 * on `pointerleave` of the row as a whole; the gaps between the buttons no
 * longer collapse anything. A hand-off then collapses one button and expands
 * its neighbour in the same frame, and since a button only ever grows
 * leftwards, the neighbour grows around the pointer rather than away from it.
 */
export function HeaderActionGroup({
	className,
	children,
	...props
}: ComponentPropsWithoutRef<"div">) {
	const [activeId, setActiveId] = useState<string | null>(null);
	const value = useMemo<HeaderActionGroupValue>(
		() => ({ activeId, activate: setActiveId }),
		[activeId],
	);

	return (
		<HeaderActionGroupContext.Provider value={value}>
			<div
				{...props}
				className={cn("flex min-w-0 items-center justify-end", className)}
				onPointerLeave={() => setActiveId(null)}
			>
				{children}
			</div>
		</HeaderActionGroupContext.Provider>
	);
}

interface HeaderActionProps extends ComponentPropsWithoutRef<"button"> {
	/** Glyph shown at rest — sized by the button's own `[&_svg]:size-4` rule. */
	icon: ReactNode;
	/** Revealed on hover/focus, and the button's accessible name at all times. */
	label: string;
}

/**
 * A header button that rests as a bare glyph and grows its label out of its
 * left edge while it is the active action of its `HeaderActionGroup`. The
 * header row is right-aligned, so the extra width is taken from the left and
 * the glyph itself keeps its distance to the edge.
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
	const group = useContext(HeaderActionGroupContext);
	const id = useId();

	if (!group) {
		throw new Error("HeaderAction must be rendered in a HeaderActionGroup");
	}

	return (
		// The wrapper hears the pointer, not the button: the button variants give
		// a disabled button `pointer-events-none`, and an action that can't report
		// itself would leave the neighbour's label open while the pointer sits on
		// it — and then jump the row when the pointer moved on.
		<span
			className="inline-flex shrink-0"
			onPointerEnter={() => group.activate(id)}
		>
			<Button
				variant="ghost"
				// px-2.5 + a 16px glyph is a 36px square while collapsed, matching the
				// row's other controls; the label column supplies its own leading gap
				// so there is nothing to animate but the one grid track.
				// The tint keys off the same state as the label rather than off
				// `:hover`, so a button stays lit while the pointer is between two
				// of them and can't flicker out of step with its own reveal.
				className={cn(
					"group h-9 shrink-0 gap-0 rounded-lg px-2.5 text-muted-foreground data-[expanded]:bg-foreground/10 data-[expanded]:text-foreground",
					className,
				)}
				data-expanded={group.activeId === id || undefined}
				{...props}
			>
				{icon}
				<span className="grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out group-data-[expanded]:grid-cols-[1fr] group-focus-visible:grid-cols-[1fr] motion-reduce:transition-none">
					<span className="overflow-hidden">
						<span className="block whitespace-nowrap pl-2 pr-0.5">{label}</span>
					</span>
				</span>
			</Button>
		</span>
	);
}
