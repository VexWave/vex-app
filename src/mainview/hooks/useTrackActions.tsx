import { useCallback, useState, type ReactNode } from "react";
import { playlistService } from "@/api/PlaylistService";
import { DeleteTrackDialog } from "@/components/DeleteTrackDialog";
import { EditTrackDialog } from "@/components/EditTrackDialog";
import { PlaylistDialog } from "@/components/PlaylistDialog";
import type { Track } from "@/player/types";

export interface TrackActions {
	/** Open the edit dialog (title, cover, artists) for a track. */
	edit: (track: Track) => void;
	/** Ask to delete a track from the server. */
	remove: (track: Track) => void;
	/** Add/remove a track to/from a playlist, by its current membership. */
	togglePlaylist: (track: Track, playlistId: number, isMember: boolean) => void;
	/** Create a playlist seeded with this track. */
	newPlaylist: (track: Track) => void;
	/** The dialogs the callbacks open — render once per list. */
	dialogs: ReactNode;
}

/**
 * The track actions any list of library tracks offers, plus the dialogs they
 * open. A list renders `dialogs` once and hands the callbacks to its rows, so
 * every view of a track — the library, an artist's tracks, a playlist — edits
 * and deletes it identically without repeating the plumbing. A list takes only
 * the callbacks its rows offer; the dialogs it leaves unreachable stay closed.
 *
 * Every callback is referentially stable, which is what lets the rows that
 * receive them stay memoized across the player's timeupdate re-renders.
 */
export function useTrackActions(): TrackActions {
	// Which track each dialog targets; null closes it.
	const [editTrack, setEditTrack] = useState<Track | null>(null);
	const [deleteTrack, setDeleteTrack] = useState<Track | null>(null);
	// Track waiting to seed a brand-new playlist ("New playlist…" menu item).
	const [playlistSeed, setPlaylistSeed] = useState<Track | null>(null);

	const togglePlaylist = useCallback(
		(track: Track, playlistId: number, isMember: boolean) => {
			void (isMember
				? playlistService.removeTracks(playlistId, [track.id])
				: playlistService.addTracks(playlistId, [track.id]));
		},
		[],
	);

	const dialogs = (
		<>
			<EditTrackDialog
				track={editTrack}
				open={editTrack !== null}
				onOpenChange={(open) => {
					if (!open) setEditTrack(null);
				}}
			/>

			{/* "New playlist…" from a row's context menu: create-mode dialog
			    seeded with that track, so the new playlist starts with it. */}
			<PlaylistDialog
				playlist={null}
				seedTrackIds={playlistSeed ? [playlistSeed.id] : undefined}
				open={playlistSeed !== null}
				onOpenChange={(open) => {
					if (!open) setPlaylistSeed(null);
				}}
			/>

			<DeleteTrackDialog
				track={deleteTrack}
				open={deleteTrack !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteTrack(null);
				}}
			/>
		</>
	);

	return {
		edit: setEditTrack,
		remove: setDeleteTrack,
		togglePlaylist,
		newPlaylist: setPlaylistSeed,
		dialogs,
	};
}
