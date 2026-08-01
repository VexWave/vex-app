import { memo } from "react";
import {
	TrackArtistItems,
	TrackDeleteItem,
	TrackEditItem,
	TrackPlaylistsSubmenu,
} from "@/components/TrackMenuItems";
import { TrackRow } from "@/components/TrackRow";
import { ContextMenuSeparator } from "@/components/ui/context-menu";
import type { RemoteArtist, RemotePlaylist } from "../../shared/rpcSchema";
import type { Track } from "@/player/types";

/**
 * A library row: the shared TrackRow plus the full set of track actions.
 * Playing it starts the whole library at this track's index.
 *
 * Memoized: TrackList re-renders on every player timeupdate and on every
 * import/upload progress tick, and without this each of those rebuilt every
 * row (incl. a Radix ContextMenu apiece). All props are referentially stable
 * across those ticks except the booleans, which only change for rows
 * entering/leaving the current-track state (the `playlists` array and the
 * callbacks only change on the rare library/playlist refresh).
 */
export const LibraryTrackRow = memo(function LibraryTrackRow({
	track,
	index,
	artistNames,
	isCurrent,
	showBars,
	playlists,
	artists,
	onPlay,
	onEdit,
	onDelete,
	onTogglePlaylist,
	onNewPlaylist,
	onOpenArtist,
}: {
	track: Track;
	/** Position in the library — what playback addresses, not the row number. */
	index: number;
	/** The track's linked artist names, for the "Go to artist" entry. */
	artistNames: readonly string[] | undefined;
	isCurrent: boolean;
	showBars: boolean;
	playlists: RemotePlaylist[];
	artists: RemoteArtist[];
	onPlay: (index: number) => void;
	onEdit: (track: Track) => void;
	onDelete: (track: Track) => void;
	onTogglePlaylist: (
		track: Track,
		playlistId: number,
		isMember: boolean,
	) => void;
	onNewPlaylist: (track: Track) => void;
	onOpenArtist: (artistId: number) => void;
}) {
	return (
		<TrackRow
			track={track}
			position={index + 1}
			isCurrent={isCurrent}
			showBars={showBars}
			onPlay={() => onPlay(index)}
			menuClassName="w-44"
			menu={
				<>
					<TrackEditItem onSelect={() => onEdit(track)} />
					<TrackArtistItems
						artistNames={artistNames}
						artists={artists}
						onOpenArtist={onOpenArtist}
					/>
					<TrackPlaylistsSubmenu
						track={track}
						playlists={playlists}
						onToggle={onTogglePlaylist}
						onNewPlaylist={onNewPlaylist}
					/>
					<ContextMenuSeparator />
					<TrackDeleteItem onSelect={() => onDelete(track)} />
				</>
			}
		/>
	);
});
