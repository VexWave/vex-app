import { memo } from "react";
import {
	ArrowDown,
	ArrowUp,
	EllipsisVertical,
	Music,
	Pencil,
	Play,
	X,
} from "lucide-react";
import { NowPlayingBars } from "@/components/NowPlayingBars";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { openRowMenu } from "@/lib/rowMenu";
import { cn, formatTime } from "@/lib/utils";
import type { Track } from "@/player/types";

/**
 * One row of the open playlist's ordered track list. Memoized for the same
 * reason as TrackRow: the detail view re-renders on every player timeupdate,
 * and this keeps those ticks from rebuilding every row (incl. a Radix
 * ContextMenu apiece). All props are referentially stable across ticks except
 * the booleans on rows entering/leaving the current-track state.
 */
export const PlaylistTrackRow = memo(function PlaylistTrackRow({
	track,
	rowIndex,
	serverId,
	isCurrent,
	showBars,
	canMoveUp,
	canMoveDown,
	onPlay,
	onEdit,
	onMove,
	onRemove,
}: {
	track: Track;
	rowIndex: number;
	/** Server-side track id — membership edits are addressed by it. */
	serverId: number;
	isCurrent: boolean;
	showBars: boolean;
	canMoveUp: boolean;
	canMoveDown: boolean;
	onPlay: (rowIndex: number) => void;
	onEdit: (track: Track) => void;
	onMove: (serverId: number, direction: -1 | 1) => void;
	onRemove: (serverId: number) => void;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					role="button"
					tabIndex={0}
					onClick={() => onPlay(rowIndex)}
					onKeyDown={(e) => {
						// Keys on the inner kebab button bubble here; without this
						// guard, activating the menu would also play the row.
						if (e.target !== e.currentTarget) return;
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onPlay(rowIndex);
						}
					}}
					className={cn(
						"group relative flex w-full cursor-pointer items-center gap-3 rounded-lg py-2 pl-3 pr-2.5 text-left transition-colors",
						isCurrent ? "bg-accent" : "hover:bg-accent/60",
					)}
				>
					<span
						aria-hidden="true"
						className={cn(
							"absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-opacity",
							isCurrent ? "opacity-100" : "opacity-0",
						)}
					/>
					<span className="flex w-5 shrink-0 justify-center text-xs tabular-nums text-muted-foreground">
						{showBars ? <NowPlayingBars /> : rowIndex + 1}
					</span>
					<div
						className={cn(
							"relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-muted shadow-sm ring-1 ring-inset ring-border/60 transition-shadow",
							isCurrent && "ring-primary/40",
						)}
					>
						{track.coverUrl ? (
							<img
								src={track.coverUrl}
								alt=""
								className="h-full w-full object-cover"
							/>
						) : (
							<Music className="absolute inset-0 m-auto h-5 w-5 text-muted-foreground" />
						)}
						<div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
							<Play className="h-4 w-4 fill-white text-white" />
						</div>
					</div>
					<div className="min-w-0 flex-1">
						<p
							className={cn(
								"truncate text-sm font-medium",
								isCurrent && "text-primary",
							)}
						>
							{track.title}
						</p>
						<p className="truncate text-xs text-muted-foreground">
							{track.artist ?? "Unknown artist"}
						</p>
					</div>
					<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
						{formatTime(track.durationSec)}
					</span>
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
						aria-label={`More options for ${track.title}`}
						onClick={(e) => {
							e.stopPropagation();
							openRowMenu(e.currentTarget);
						}}
					>
						<EllipsisVertical className="h-4 w-4" />
					</Button>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-52">
				<ContextMenuItem onSelect={() => onEdit(track)}>
					<Pencil className="h-4 w-4" />
					Edit…
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem
					disabled={!canMoveUp}
					onSelect={() => onMove(serverId, -1)}
				>
					<ArrowUp className="h-4 w-4" />
					Move up
				</ContextMenuItem>
				<ContextMenuItem
					disabled={!canMoveDown}
					onSelect={() => onMove(serverId, 1)}
				>
					<ArrowDown className="h-4 w-4" />
					Move down
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem
					className="text-destructive focus:text-destructive"
					onSelect={() => onRemove(serverId)}
				>
					<X className="h-4 w-4" />
					Remove from playlist
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
});
