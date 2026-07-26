import type { ReactNode } from "react";
import { ChevronLeft, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The banner an opened collection (a playlist, an artist) is introduced by:
 * the way back to its grid, its artwork, what it is, its name and size, and
 * the actions that apply to the whole thing — with play/pause always last as
 * the primary one.
 *
 * Both detail views share it so that a playlist and an artist are recognizably
 * the same kind of page; only the artwork's shape and the extra `actions`
 * differ between them.
 */
export function CollectionHeader({
	onBack,
	backLabel,
	artwork,
	eyebrow,
	title,
	meta,
	playing,
	playLabel,
	onPlay,
	playDisabled,
	actions,
}: {
	onBack: () => void;
	backLabel: string;
	artwork: ReactNode;
	/** What kind of collection this is, above the name ("Playlist", "Artist"). */
	eyebrow: string;
	title: string;
	/** Size line under the name, e.g. "12 tracks · 48:20". */
	meta: string;
	/** The collection owns the queue and audio is running. */
	playing: boolean;
	playLabel: string;
	onPlay: () => void;
	playDisabled: boolean;
	actions?: ReactNode;
}) {
	return (
		<div className="relative flex items-end gap-4 border-b bg-gradient-to-b from-accent/50 via-accent/10 to-transparent px-4 pb-4 pt-10">
			<Button
				variant="ghost"
				size="icon"
				className="absolute left-2 top-2 h-7 w-7"
				aria-label={backLabel}
				onClick={onBack}
			>
				<ChevronLeft className="h-4 w-4" />
			</Button>

			{artwork}

			<div className="min-w-0 flex-1">
				<p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
					{eyebrow}
				</p>
				{/* Long names shrink rather than wrap: the banner's height is fixed
				    so the track list below it never shifts between collections. */}
				<h2 className="truncate text-2xl font-semibold tracking-tight">
					{title}
				</h2>
				<p className="truncate text-xs text-muted-foreground">{meta}</p>
			</div>

			<div className="flex shrink-0 items-center gap-2">
				{actions}
				<Button
					size="sm"
					className="rounded-full px-4"
					disabled={playDisabled}
					aria-label={playLabel}
					onClick={onPlay}
				>
					{playing ? (
						<>
							<Pause className="h-4 w-4 fill-current" />
							Pause
						</>
					) : (
						<>
							<Play className="h-4 w-4 fill-current" />
							Play
						</>
					)}
				</Button>
			</div>
		</div>
	);
}
