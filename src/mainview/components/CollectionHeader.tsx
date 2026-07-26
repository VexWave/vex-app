import type { ReactNode } from "react";
import { ChevronLeft, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The banner an opened collection (a playlist, an artist) is introduced by:
 * the way back to its grid, its artwork, its name and size, and the actions
 * that apply to the whole thing — with play/pause always last as the primary
 * one.
 *
 * Both detail views share it so that a playlist and an artist are recognizably
 * the same kind of page; only the artwork's shape and the extra `actions`
 * differ between them.
 *
 * The way back is a labelled breadcrumb rather than a bare arrow floating over
 * the artwork: it doubles as the "where am I" line the banner would otherwise
 * spend a row on, and it reads as a destination ("Artists") instead of leaving
 * the user to guess what an arrow in a corner would do.
 */
export function CollectionHeader({
	onBack,
	parentLabel,
	artwork,
	title,
	meta,
	playing,
	playLabel,
	onPlay,
	playDisabled,
	actions,
}: {
	onBack: () => void;
	/** The list this collection sits in — the breadcrumb's text ("Artists"). */
	parentLabel: string;
	artwork: ReactNode;
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
		<div className="flex flex-col gap-1.5 border-b bg-gradient-to-b from-accent/50 via-accent/10 to-transparent px-4 pb-3.5 pt-2.5">
			<button
				type="button"
				onClick={onBack}
				// -ml-1.5 pulls the chevron's own padding back so the label lines
				// up with the title below it.
				className="-ml-1.5 flex w-fit items-center gap-0.5 rounded-md py-0.5 pl-0.5 pr-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			>
				<ChevronLeft className="h-3.5 w-3.5" />
				{parentLabel}
			</button>

			<div className="flex items-end gap-3.5">
				{artwork}

				<div className="min-w-0 flex-1">
					{/* Long names shrink rather than wrap: the banner's height is
					    fixed so the track list below it never shifts between
					    collections. */}
					<h2 className="truncate text-xl font-semibold tracking-tight">
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
		</div>
	);
}
