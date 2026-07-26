import { useCallback, useMemo, useState } from "react";
import { Music, Search, X } from "lucide-react";
import { LIBRARY_QUEUE_CONTEXT, libraryService } from "@/api/LibraryService";
import { playlistService } from "@/api/PlaylistService";
import { DeleteTrackDialog } from "@/components/DeleteTrackDialog";
import { EditTrackDialog } from "@/components/EditTrackDialog";
import { PendingImportRow, PendingUploadRow } from "@/components/PendingRows";
import { PlaylistDialog } from "@/components/PlaylistDialog";
import { TrackRow } from "@/components/TrackRow";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useImports } from "@/hooks/useImports";
import { useLibrary } from "@/hooks/useLibrary";
import { usePlayer } from "@/hooks/usePlayer";
import { usePlaylists } from "@/hooks/usePlaylists";
import { useUploads } from "@/hooks/useUploads";
import { formatTime } from "@/lib/utils";
import type { Track } from "@/player/types";

/** Case-insensitive "does any of these fields contain the query" test. */
function matches(query: string, ...fields: (string | undefined)[]): boolean {
	if (!query) return true;
	const needle = query.toLowerCase();
	return fields.some((field) => field?.toLowerCase().includes(needle));
}

export function TrackList() {
	const { state, controller } = usePlayer();
	const { library } = useLibrary();
	const { playlists } = usePlaylists();
	const { uploads } = useUploads();
	const { imports } = useImports();
	// The dialogs are rendered once for the whole list; the context menu sets
	// which track they target.
	const [editTrack, setEditTrack] = useState<Track | null>(null);
	const [deleteTrack, setDeleteTrack] = useState<Track | null>(null);
	// Track waiting to seed a brand-new playlist ("New playlist…" menu item).
	const [playlistSeed, setPlaylistSeed] = useState<Track | null>(null);
	// Purely a view filter over the library list — it never trims the list
	// itself, so playback and the numbering keep using the library index.
	const [query, setQuery] = useState("");
	const tracks = library.tracks;
	// Playing a library row makes the whole library the queue, in its order.
	const playTrackAt = useCallback(
		(index: number) =>
			controller.playCollection(LIBRARY_QUEUE_CONTEXT, tracks, index),
		[controller, tracks],
	);
	const togglePlaylist = useCallback(
		(track: Track, playlistId: number, isMember: boolean) => {
			const serverId = libraryService.getRemote(track.id)?.id;
			if (serverId === undefined) return;
			void (isMember
				? playlistService.removeTracks(playlistId, [serverId])
				: playlistService.addTracks(playlistId, [serverId]));
		},
		[],
	);

	const totalSec = useMemo(
		() => tracks.reduce((sum, track) => sum + track.durationSec, 0),
		[tracks],
	);
	// Pair each track with its library index *before* filtering: the row plays
	// `index`, so a filtered-list position would start the wrong track.
	const visible = useMemo(
		() =>
			tracks
				.map((track, index) => ({ track, index }))
				.filter(({ track }) =>
					matches(query, track.title, track.artist, track.album),
				),
		[tracks, query],
	);
	const visibleImports = imports.filter((job) =>
		matches(query, job.title ?? undefined, job.url),
	);
	const visibleUploads = uploads.filter((upload) =>
		matches(query, upload.title),
	);

	// The now-playing highlight belongs to the collection the queue mirrors:
	// a track playing from a playlist is that playlist's business, not the
	// library row's, even though both render the same track.
	const ownsQueue = state.queueContextId === LIBRARY_QUEUE_CONTEXT;

	const isEmpty =
		tracks.length === 0 && uploads.length === 0 && imports.length === 0;
	const noMatches =
		!isEmpty &&
		visible.length === 0 &&
		visibleImports.length === 0 &&
		visibleUploads.length === 0;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-3 px-4 py-2.5">
				<h2 className="shrink-0 text-sm font-semibold">Library</h2>
				{tracks.length > 0 && (
					<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
						{tracks.length} {tracks.length === 1 ? "track" : "tracks"} ·{" "}
						{formatTime(totalSec)}
					</span>
				)}
				<div className="relative ml-auto w-40 min-w-0">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search"
						aria-label="Search tracks"
						className="h-8 pl-8 pr-7 text-xs"
					/>
					{query && (
						<button
							type="button"
							aria-label="Clear search"
							className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
							onClick={() => setQuery("")}
						>
							<X className="h-3.5 w-3.5" />
						</button>
					)}
				</div>
			</div>
			<Separator />

			{isEmpty ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
					<div className="flex h-20 w-20 items-center justify-center rounded-full border border-dashed">
						<Music className="h-9 w-9" />
					</div>
					<p className="text-sm">
						Your library is empty — add songs or drop audio files anywhere.
					</p>
				</div>
			) : noMatches ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
					<Search className="h-8 w-8" />
					<p className="text-sm">No tracks match “{query}”.</p>
				</div>
			) : (
				<ScrollArea className="min-h-0 flex-1">
					<ul className="flex flex-col gap-1 p-2">
						{visibleImports.map((job) => (
							<li key={job.id}>
								<PendingImportRow job={job} />
							</li>
						))}
						{visibleUploads.map((upload) => (
							<li key={upload.id}>
								<PendingUploadRow upload={upload} />
							</li>
						))}
						{visible.map(({ track, index }) => {
							// Playlist membership is keyed by server id; map the track
							// id back to one for the row's playlist checkboxes.
							const serverId = libraryService.getRemote(track.id)?.id;
							const isCurrent =
								ownsQueue && track.id === state.currentTrack?.id;
							return (
								<li key={track.id}>
									<TrackRow
										track={track}
										index={index}
										serverId={serverId}
										isCurrent={isCurrent}
										showBars={isCurrent && state.isPlaying}
										playlists={playlists.playlists}
										onPlay={playTrackAt}
										onEdit={setEditTrack}
										onDelete={setDeleteTrack}
										onTogglePlaylist={togglePlaylist}
										onNewPlaylist={setPlaylistSeed}
									/>
								</li>
							);
						})}
					</ul>
				</ScrollArea>
			)}

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
				seedTrackIds={
					playlistSeed
						? [libraryService.getRemote(playlistSeed.id)?.id].filter(
								(id): id is number => id !== undefined,
							)
						: undefined
				}
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
		</div>
	);
}
