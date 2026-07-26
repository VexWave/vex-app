import { memo } from "react";
import {
	EllipsisVertical,
	ListMusic,
	Music,
	Pencil,
	Play,
	Plus,
	Trash2,
} from "lucide-react";
import { NowPlayingBars } from "@/components/NowPlayingBars";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { openRowMenu } from "@/lib/rowMenu";
import { cn, formatTime } from "@/lib/utils";
import type { RemotePlaylist } from "../../shared/rpcSchema";
import type { Track } from "@/player/types";

/**
 * One playable library row. Memoized: TrackList re-renders on every player
 * timeupdate and on every import/upload progress tick, and without this each
 * of those rebuilt every row (incl. a Radix ContextMenu apiece). All props are
 * referentially stable across those ticks except the booleans, which only
 * change for rows entering/leaving the current-track state (the `playlists`
 * array and `onPlay` only change on the rare library/playlist refresh).
 */
export const TrackRow = memo(function TrackRow({
	track,
	index,
	serverId,
	isCurrent,
	showBars,
	playlists,
	onPlay,
	onEdit,
	onDelete,
	onTogglePlaylist,
	onNewPlaylist,
}: {
	track: Track;
	index: number;
	/** Server-side id, for playlist membership; undefined while unresolved. */
	serverId: number | undefined;
	isCurrent: boolean;
	showBars: boolean;
	playlists: RemotePlaylist[];
	onPlay: (index: number) => void;
	onEdit: (track: Track) => void;
	onDelete: (track: Track) => void;
	onTogglePlaylist: (track: Track, playlistId: number, isMember: boolean) => void;
	onNewPlaylist: (track: Track) => void;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					role="button"
					tabIndex={0}
					onClick={() => onPlay(index)}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onPlay(index);
						}
					}}
					className={cn(
						"group relative flex w-full cursor-pointer items-center gap-3 rounded-lg py-2 pl-3 pr-2.5 text-left transition-colors",
						isCurrent ? "bg-accent" : "hover:bg-accent/60",
					)}
				>
					{/* Same accent rail the sidebar uses for its active item. */}
					<span
						aria-hidden="true"
						className={cn(
							"absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-opacity",
							isCurrent ? "opacity-100" : "opacity-0",
						)}
					/>
					{/* Queue position, replaced by the equalizer on the playing row. */}
					<span className="flex w-5 shrink-0 justify-center text-xs tabular-nums text-muted-foreground">
						{showBars ? <NowPlayingBars /> : index + 1}
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
							{track.album ? ` · ${track.album}` : ""}
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
			<ContextMenuContent className="w-44">
				<ContextMenuItem onSelect={() => onEdit(track)}>
					<Pencil className="h-4 w-4" />
					Edit…
				</ContextMenuItem>
				<ContextMenuSub>
					<ContextMenuSubTrigger className="gap-2 [&>svg]:size-4 [&>svg]:shrink-0">
						<ListMusic className="h-4 w-4" />
						Playlists
					</ContextMenuSubTrigger>
					<ContextMenuSubContent className="w-48">
						<ContextMenuItem onSelect={() => onNewPlaylist(track)}>
							<Plus className="h-4 w-4" />
							New playlist…
						</ContextMenuItem>
						{playlists.length > 0 && <ContextMenuSeparator />}
						{playlists.map((playlist) => {
							const isMember =
								serverId !== undefined &&
								playlist.trackIds.includes(serverId);
							return (
								<ContextMenuCheckboxItem
									key={playlist.id}
									checked={isMember}
									disabled={serverId === undefined}
									// Keep the menu open so several playlists can be
									// (un)checked in one go.
									onSelect={(e) => e.preventDefault()}
									onCheckedChange={() =>
										onTogglePlaylist(track, playlist.id, isMember)
									}
								>
									<span className="truncate">{playlist.name}</span>
								</ContextMenuCheckboxItem>
							);
						})}
					</ContextMenuSubContent>
				</ContextMenuSub>
				<ContextMenuSeparator />
				<ContextMenuItem
					className="text-destructive focus:text-destructive"
					onSelect={() => onDelete(track)}
				>
					<Trash2 className="h-4 w-4" />
					Delete from server
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
});
