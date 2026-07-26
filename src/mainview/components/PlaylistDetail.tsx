import { useCallback, useMemo, useState } from "react";
import {
	ChevronLeft,
	ListMusic,
	ListPlus,
	Pause,
	Pencil,
	Play,
} from "lucide-react";
import { trackIdForServerId } from "@/api/LibraryService";
import { playlistQueueContext, playlistService } from "@/api/PlaylistService";
import { AddTracksDialog } from "@/components/AddTracksDialog";
import { EditTrackDialog } from "@/components/EditTrackDialog";
import { PlaylistCover } from "@/components/PlaylistCover";
import { PlaylistsErrorBanner } from "@/components/PlaylistsErrorBanner";
import { PlaylistTrackRow } from "@/components/PlaylistTrackRow";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useLibrary } from "@/hooks/useLibrary";
import { usePlayer } from "@/hooks/usePlayer";
import { usePlaylists } from "@/hooks/usePlaylists";
import { formatTime } from "@/lib/utils";
import type { RemotePlaylist } from "../../shared/rpcSchema";
import type { Track } from "@/player/types";

/** The opened playlist: header with cover/meta/actions plus its track rows. */
export function PlaylistDetail({
	playlist,
	onBack,
	onEdit,
}: {
	playlist: RemotePlaylist;
	onBack: () => void;
	onEdit: () => void;
}) {
	const { state } = usePlayer();
	const { library } = useLibrary();
	const { playlists } = usePlaylists();
	const [addOpen, setAddOpen] = useState(false);
	// Track targeted by a row's "Edit…" menu item (same dialog as the library).
	const [editTrack, setEditTrack] = useState<Track | null>(null);

	// Join the ordered trackIds against the library. `position` is the index
	// into trackIds (only used for the move-bound checks); the row index is
	// the position in the *joined* list (what playback addresses) — they
	// diverge only while a dangling id awaits the next playlists refresh.
	const rows = useMemo(() => {
		const byId = new Map(library.tracks.map((track) => [track.id, track]));
		return playlist.trackIds.flatMap((serverId, position) => {
			const track = byId.get(trackIdForServerId(serverId));
			return track ? [{ track, serverId, position }] : [];
		});
	}, [playlist, library.tracks]);

	// Stable row handlers — they only change on the (rare) playlists refresh,
	// so the memoized rows survive the per-second timeupdate re-renders.
	const playRow = useCallback(
		(rowIndex: number) => playlistService.play(playlist, rowIndex),
		[playlist],
	);
	const moveRow = useCallback(
		(serverId: number, direction: -1 | 1) =>
			void playlistService.moveTrack(playlist.id, serverId, direction),
		[playlist.id],
	);
	const removeRow = useCallback(
		(serverId: number) =>
			void playlistService.removeTracks(playlist.id, [serverId]),
		[playlist.id],
	);

	const totalSec = useMemo(
		() => rows.reduce((sum, row) => sum + row.track.durationSec, 0),
		[rows],
	);
	// Whether this playlist is what the queue mirrors — then the Play button
	// becomes a pause/resume toggle instead of restarting from the top, and
	// the rows may mark the current track (the now-playing highlight belongs
	// to the collection the queue mirrors, not to every view of the track).
	const ownsQueue =
		state.queueContextId === playlistQueueContext(playlist.id);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-3 px-4 py-2.5">
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7 shrink-0"
					aria-label="Back to playlists"
					onClick={onBack}
				>
					<ChevronLeft className="h-4 w-4" />
				</Button>
				<PlaylistCover
					playlist={playlist}
					tracks={rows.map((row) => row.track)}
					className="h-12 w-12 shrink-0"
					iconClassName="h-5 w-5"
				/>
				<div className="min-w-0 flex-1">
					<h2 className="truncate text-sm font-semibold">{playlist.name}</h2>
					<p className="truncate text-xs text-muted-foreground">
						{rows.length} {rows.length === 1 ? "track" : "tracks"}
						{rows.length > 0 ? ` · ${formatTime(totalSec)}` : ""}
					</p>
				</div>
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7 shrink-0"
					aria-label={`Edit ${playlist.name}`}
					onClick={onEdit}
				>
					<Pencil className="h-4 w-4" />
				</Button>
				<Button
					variant="secondary"
					size="sm"
					className="shrink-0"
					onClick={() => setAddOpen(true)}
				>
					<ListPlus className="h-4 w-4" />
					Add tracks
				</Button>
				<Button
					size="sm"
					className="shrink-0"
					disabled={rows.length === 0}
					onClick={() => playlistService.playOrToggle(playlist)}
				>
					{ownsQueue && state.isPlaying ? (
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
			<Separator />

			<PlaylistsErrorBanner error={playlists.error} />

			{rows.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
					<ListMusic className="h-12 w-12" />
					<p className="text-sm">
						This playlist is empty — add tracks from the library.
					</p>
				</div>
			) : (
				<ScrollArea className="min-h-0 flex-1">
					<ul className="flex flex-col gap-1 p-2">
						{rows.map(({ track, serverId, position }, rowIndex) => {
							// A track is in a playlist at most once, so within the
							// owning playlist the id match is unambiguous.
							const isCurrent =
								ownsQueue && track.id === state.currentTrack?.id;
							return (
								<li key={track.id}>
									<PlaylistTrackRow
										track={track}
										rowIndex={rowIndex}
										serverId={serverId}
										isCurrent={isCurrent}
										showBars={isCurrent && state.isPlaying}
										canMoveUp={position > 0}
										canMoveDown={position < playlist.trackIds.length - 1}
										onPlay={playRow}
										onEdit={setEditTrack}
										onMove={moveRow}
										onRemove={removeRow}
									/>
								</li>
							);
						})}
					</ul>
				</ScrollArea>
			)}

			<AddTracksDialog
				playlist={playlist}
				open={addOpen}
				onOpenChange={setAddOpen}
			/>

			<EditTrackDialog
				track={editTrack}
				open={editTrack !== null}
				onOpenChange={(open) => {
					if (!open) setEditTrack(null);
				}}
			/>
		</div>
	);
}
