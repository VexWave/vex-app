import { memo, useMemo } from "react";
import { Pause, Play } from "lucide-react";
import { playlistService } from "@/api/PlaylistService";
import { NowPlayingBars } from "@/components/NowPlayingBars";
import { PlaylistCover } from "@/components/PlaylistCover";
import { useLibrary } from "@/hooks/useLibrary";
import { cn } from "@/lib/utils";
import type { RemotePlaylist } from "../../shared/rpcSchema";

/**
 * One playlist in the sidebar: cover, name, a hover play/pause overlay on
 * the cover, and the equalizer while it is what's playing. Clicking the row
 * opens the playlist's detail view.
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
	/** ownsQueue and audio is running — animates the equalizer. */
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
				"group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg py-1.5 pl-2 pr-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
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
			<div className="relative h-8 w-8 shrink-0">
				<PlaylistCover
					playlist={playlist}
					tracks={tracks}
					className="h-full w-full"
					iconClassName="h-3.5 w-3.5"
				/>
				{/* Play sits on the cover so the row click stays "open". While the
				    playlist owns a paused queue the overlay resumes; empty
				    playlists get no button (nothing to start). */}
				{tracks.length > 0 && (
					<button
						type="button"
						aria-label={
							playing ? `Pause ${playlist.name}` : `Play ${playlist.name}`
						}
						className="absolute inset-0 flex items-center justify-center rounded-md bg-black/50 opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
						onClick={(e) => {
							e.stopPropagation();
							playlistService.playOrToggle(playlist);
						}}
					>
						{playing ? (
							<Pause className="h-3.5 w-3.5 fill-white text-white" />
						) : (
							<Play className="h-3.5 w-3.5 fill-white text-white" />
						)}
					</button>
				)}
			</div>
			<span
				className={cn(
					"min-w-0 flex-1 truncate text-sm font-medium transition-colors",
					// The primary tint marks the queue's playlist even while paused;
					// the equalizer only animates during actual playback.
					ownsQueue
						? "text-primary"
						: active
							? "text-accent-foreground"
							: "text-muted-foreground group-hover:text-foreground",
				)}
			>
				{playlist.name}
			</span>
			{playing && <NowPlayingBars />}
		</div>
	);
});
