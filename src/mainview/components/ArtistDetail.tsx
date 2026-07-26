import { useCallback, useMemo } from "react";
import { Pencil, Users } from "lucide-react";
import { artistQueueContext, artistService } from "@/api/ArtistService";
import { libraryService } from "@/api/LibraryService";
import { ArtistAvatar } from "@/components/ArtistAvatar";
import { ArtistTrackRow } from "@/components/ArtistTrackRow";
import { CollectionHeader } from "@/components/CollectionHeader";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useArtists } from "@/hooks/useArtists";
import { useLibrary } from "@/hooks/useLibrary";
import { usePlayer } from "@/hooks/usePlayer";
import { usePlaylists } from "@/hooks/usePlaylists";
import { useTrackActions } from "@/hooks/useTrackActions";
import { formatTime, trackCountLabel } from "@/lib/utils";
import type { RemoteArtist } from "../../shared/rpcSchema";
import type { Track } from "@/player/types";

/** The opened artist: banner with avatar/meta/actions plus its tracks. */
export function ArtistDetail({
	artist,
	onBack,
	onEdit,
}: {
	artist: RemoteArtist;
	onBack: () => void;
	onEdit: () => void;
}) {
	const { state } = usePlayer();
	const { library } = useLibrary();
	const { artists } = useArtists();
	const { playlists } = usePlaylists();
	const actions = useTrackActions();

	// tracksOf projects the library snapshot onto this artist; `library.tracks`
	// is in the deps purely as the recompute trigger for that read.
	const tracks = useMemo(
		() => artistService.tracksOf(artist),
		[artist, library.tracks],
	);
	const totalSec = useMemo(
		() => tracks.reduce((sum, track) => sum + track.durationSec, 0),
		[tracks],
	);

	// Stable row handlers — they only change when the artist does, so the rows
	// stay memoized through the per-second timeupdate re-renders.
	const playRow = useCallback(
		(rowIndex: number) => artistService.play(artist, rowIndex),
		[artist],
	);
	const unlinkRow = useCallback(
		(track: Track) => void artistService.unlinkTrack(artist, track.id),
		[artist],
	);

	// Whether this artist is what the queue mirrors — then the Play button
	// becomes a pause/resume toggle instead of restarting from the top, and the
	// rows may mark the current track (the now-playing highlight belongs to the
	// collection the queue mirrors, not to every view of the track).
	const ownsQueue = state.queueContextId === artistQueueContext(artist.id);

	return (
		<div className="flex h-full flex-col">
			<CollectionHeader
				onBack={onBack}
				parentLabel="Artists"
				artwork={
					<ArtistAvatar
						imageUrl={artist.imageUrl}
						className="h-16 w-16 shadow-md ring-1 ring-inset ring-border/60"
						iconClassName="h-7 w-7"
					/>
				}
				title={artist.name}
				meta={`${trackCountLabel(tracks.length)}${
					tracks.length > 0 ? ` · ${formatTime(totalSec)}` : ""
				}`}
				playing={ownsQueue && state.isPlaying}
				playLabel={
					ownsQueue && state.isPlaying
						? `Pause ${artist.name}`
						: `Play ${artist.name}`
				}
				playDisabled={tracks.length === 0}
				onPlay={() => artistService.playOrToggle(artist)}
				actions={
					<Button
						variant="ghost"
						size="icon"
						className="h-8 w-8"
						aria-label={`Edit ${artist.name}`}
						onClick={onEdit}
					>
						<Pencil className="h-4 w-4" />
					</Button>
				}
			/>

			<ErrorBanner error={artists.error} className="border-b" />

			{tracks.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
					<Users className="h-12 w-12" />
					<p className="text-sm">
						No tracks credited to {artist.name} yet — link some from a track's
						“Edit…” menu.
					</p>
				</div>
			) : (
				<ScrollArea className="min-h-0 flex-1">
					<ul className="flex flex-col gap-1 p-2">
						{tracks.map((track, rowIndex) => {
							// A track carries an artist at most once, so within the
							// owning artist the id match is unambiguous.
							const isCurrent =
								ownsQueue && track.id === state.currentTrack?.id;
							return (
								<li key={track.id}>
									<ArtistTrackRow
										track={track}
										rowIndex={rowIndex}
										serverId={libraryService.getRemote(track.id)?.id}
										isCurrent={isCurrent}
										showBars={isCurrent && state.isPlaying}
										playlists={playlists.playlists}
										onPlay={playRow}
										onEdit={actions.edit}
										onDelete={actions.remove}
										onUnlink={unlinkRow}
										onTogglePlaylist={actions.togglePlaylist}
										onNewPlaylist={actions.newPlaylist}
									/>
								</li>
							);
						})}
					</ul>
				</ScrollArea>
			)}

			{actions.dialogs}
		</div>
	);
}
