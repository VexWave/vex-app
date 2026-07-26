import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A failure shown in place rather than as a toast: these errors describe the
 * state of what the user is looking at — the library couldn't load, a playlist
 * edit was rejected — so they belong pinned to it. Renders nothing without an
 * error, so callers can hand it their snapshot's field directly.
 *
 * The separating border is the caller's (`border-b` above a list, `border-t`
 * for the app-level ones stacked over the player bar).
 */
export function ErrorBanner({
	error,
	className,
}: {
	error: string | null;
	className?: string;
}) {
	if (!error) return null;
	return (
		<div
			className={cn(
				"flex items-center gap-2 bg-destructive/10 px-4 py-2 text-sm text-destructive",
				className,
			)}
		>
			<AlertCircle className="h-4 w-4 shrink-0" />
			<span className="truncate">{error}</span>
		</div>
	);
}
