import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * `ErrorBanner`'s line for something worth confirming: a finished download
 * lands in a folder the user isn't looking at. The caller takes it away again.
 */
export function NoticeBanner({
	notice,
	className,
}: {
	notice: string | null;
	className?: string;
}) {
	if (!notice) return null;
	return (
		<div
			className={cn(
				"flex items-center gap-2 bg-primary/10 px-4 py-2 text-sm text-primary",
				className,
			)}
		>
			<Check className="h-4 w-4 shrink-0" />
			<span className="truncate">{notice}</span>
		</div>
	);
}
