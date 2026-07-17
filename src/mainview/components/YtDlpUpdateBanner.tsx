import { AlertCircle, ArrowUpCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useBinaries } from "@/hooks/useBinaries";

/**
 * Non-blocking hint below the nav header when a newer yt-dlp release exists.
 * Follows the inline banner idiom of the error banners above the PlayerBar,
 * but in a non-destructive tint.
 */
export function YtDlpUpdateBanner() {
	const { binaries, service } = useBinaries();

	if (binaries.updating) {
		const progress = binaries.updateProgress;
		return (
			<div className="flex items-center gap-2 border-b bg-primary/10 px-4 py-2 text-sm">
				<ArrowUpCircle className="h-4 w-4 shrink-0" />
				<span>
					{progress?.step === "extracting"
						? "Installing yt-dlp update…"
						: "Updating yt-dlp…"}
				</span>
				<Progress
					className="w-40"
					value={
						progress?.totalBytes
							? (progress.receivedBytes / progress.totalBytes) * 100
							: null
					}
				/>
			</div>
		);
	}

	if (binaries.updateError) {
		return (
			<div className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
				<AlertCircle className="h-4 w-4 shrink-0" />
				<span className="truncate">
					yt-dlp update failed: {binaries.updateError}
				</span>
				<Button
					size="sm"
					variant="outline"
					className="ml-auto shrink-0"
					onClick={() => void service.updateYtDlp()}
				>
					Retry
				</Button>
			</div>
		);
	}

	if (!binaries.updateAvailable || binaries.updateDismissed) return null;

	return (
		<div className="flex items-center gap-2 border-b bg-primary/10 px-4 py-2 text-sm">
			<ArrowUpCircle className="h-4 w-4 shrink-0" />
			<span className="truncate">
				yt-dlp {binaries.latestVersion ?? "update"} is available.
			</span>
			<Button
				size="sm"
				variant="outline"
				className="ml-auto shrink-0"
				onClick={() => void service.updateYtDlp()}
			>
				Update
			</Button>
			<Button
				size="icon"
				variant="ghost"
				className="h-7 w-7 shrink-0"
				aria-label="Dismiss update hint"
				onClick={() => service.dismissUpdate()}
			>
				<X className="h-4 w-4" />
			</Button>
		</div>
	);
}
