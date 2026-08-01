import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The centred "there is nothing here" panel every list and detail view falls
 * back to, so all of them state their emptiness the same way.
 *
 * `framed` distinguishes the two cases the app makes: a collection that has
 * nothing in it *yet* wears the dashed circle, an invitation to fill it, while a
 * filter or search that matched nothing shows the bare glyph — there is nothing
 * to invite, the list simply isn't showing what it has. The icon is the caller's,
 * with its own size: a framed glyph sits at h-9, a bare one carries the state on
 * its own and runs larger.
 */
export function EmptyState({
	icon,
	title,
	hint,
	action,
	framed,
}: {
	icon: ReactNode;
	title: ReactNode;
	/** A second, quieter line — for states that need to explain, not just report. */
	hint?: string;
	action?: ReactNode;
	framed?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex flex-1 flex-col items-center justify-center px-6 text-center text-muted-foreground",
				framed ? "gap-4" : "gap-3",
			)}
		>
			{framed ? (
				<div className="flex h-20 w-20 items-center justify-center rounded-full border border-dashed">
					{icon}
				</div>
			) : (
				icon
			)}
			{/* The measure is only capped where there is prose to wrap; a single
			    label reads better on one line than broken to a column width. */}
			<div className={cn("space-y-1.5", hint && "max-w-sm")}>
				<p className="text-sm">{title}</p>
				{hint && <p className="text-xs leading-relaxed">{hint}</p>}
			</div>
			{action}
		</div>
	);
}
