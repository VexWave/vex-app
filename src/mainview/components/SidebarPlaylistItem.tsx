import { memo, useMemo } from "react";
import { Pause, Play } from "lucide-react";
import { playlistService } from "@/api/PlaylistService";
import { NowPlayingRing } from "@/components/NowPlayingRing";
import { PlaylistCover } from "@/components/PlaylistCover";
import { Button } from "@/components/ui/button";
import { useLibrary } from "@/hooks/useLibrary";
import { cn } from "@/lib/utils";
import type { RemotePlaylist } from "../../shared/rpcSchema";

/**
 * One playlist in the sidebar: cover (wearing the NowPlayingRing while its
 * collection is the queue), name, and a play/pause button that fades in at
 * the right edge. Clicking the row opens the playlist's detail view.
 *
 * Memoized: the sidebar re-renders on every player timeupdate, and this
 * keeps those ticks from rebuilding every row. All props are referentially
 * stable across ticks except the booleans on rows entering/leaving the
 * active/playing states; the library is subscribed to *here* (for the cover
 * collage) so its changes still reach the row through the memo.
 */
export const SidebarPlaylistItem = memo(function SidebarPlaylistItem({
	playlist,
	active,
	ownsQueue,
	playing,
	onOpen,
}: {
	playlist: RemotePlaylist;
	/** The main area is showing this playlist's detail view. */
	active: boolean;
	/** The play queue mirrors this playlist (playing or paused). */
	ownsQueue: boolean;
	/** ownsQueue and audio is running — sets the ring's arc orbiting. */
	playing: boolean;
	onOpen: (playlistId: number) => void;
}) {
	const { library } = useLibrary();
	// tracksOf joins against the library snapshot; `library.tracks` is in the
	// deps purely as the recompute trigger for that read.
	const tracks = useMemo(
		() => playlistService.tracksOf(playlist),
		[playlist, library.tracks],
	);

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => onOpen(playlist.id)}
			onKeyDown={(e) => {
				// Ignore keys bubbling from the play button — it handles its own.
				if (e.target !== e.currentTarget) return;
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen(playlist.id);
				}
			}}
			aria-current={active ? "page" : undefined}
			className={cn(
				"group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg py-1.5 pl-2 pr-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				active ? "bg-accent" : "hover:bg-accent/50",
			)}
		>
			{/* Same accent rail as the nav items above. */}
			<span
				aria-hidden="true"
				className={cn(
					"absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200",
					active ? "scale-y-100 opacity-100" : "scale-y-0 opacity-0",
				)}
			/>
			<div className="relative h-7 w-7 shrink-0">
				{/* The player indicator: ringed while this playlist owns the
				    queue, the arc orbiting only during actual playback. */}
				{ownsQueue && <NowPlayingRing spinning={playing} />}
				<PlaylistCover
					playlist={playlist}
					tracks={tracks}
					className="h-full w-full"
					iconClassName="h-3 w-3"
				/>
			</div>
			<span
				className={cn(
					"min-w-0 flex-1 truncate text-sm font-medium transition-colors",
					// The primary tint marks the queue's playlist even while
					// paused; the ring's arc only orbits during actual playback.
					ownsQueue
						? "text-primary"
						: active
							? "text-accent-foreground"
							: "text-muted-foreground group-hover:text-foreground",
				)}
			>
				{playlist.name}
			</span>
			{/* Fades in at the right edge; while the playlist owns a paused
			    queue it resumes instead of restarting. Empty playlists get no
			    button (nothing to start). */}
			{tracks.length > 0 && (
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
					aria-label={
						playing ? `Pause ${playlist.name}` : `Play ${playlist.name}`
					}
					onClick={(e) => {
						e.stopPropagation();
						playlistService.playOrToggle(playlist);
					}}
				>
					{playing ? (
						<Pause className="h-3.5 w-3.5 fill-current" />
					) : (
						<Play className="h-3.5 w-3.5 fill-current" />
					)}
				</Button>
			)}
		</div>
	);
});
