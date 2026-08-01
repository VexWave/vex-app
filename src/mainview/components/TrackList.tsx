import { useCallback, useMemo, useState } from "react";
import { Music, Search } from "lucide-react";
import { LIBRARY_QUEUE_CONTEXT, libraryService } from "@/api/LibraryService";
import { navigationService } from "@/api/NavigationService";
import { EmptyState } from "@/components/EmptyState";
import { LibraryTrackRow } from "@/components/LibraryTrackRow";
import { PendingImportRow, PendingUploadRow } from "@/components/PendingRows";
import { SearchInput } from "@/components/SearchInput";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useArtists } from "@/hooks/useArtists";
import { useImports } from "@/hooks/useImports";
import { useLibrary } from "@/hooks/useLibrary";
import { usePlayer } from "@/hooks/usePlayer";
import { usePlaylists } from "@/hooks/usePlaylists";
import { useTrackActions } from "@/hooks/useTrackActions";
import { useUploads } from "@/hooks/useUploads";
import { formatTime, trackCountLabel } from "@/lib/utils";

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
	// For the rows' "Go to artist" entry: the names a track carries have to be
	// resolved against the artist list to become somewhere to navigate.
	const { artists } = useArtists();
	const { uploads } = useUploads();
	const { imports } = useImports();
	// Edit/delete/playlist actions and the dialogs they open, rendered once
	// for the whole list; the row menus just call into them.
	const actions = useTrackActions();
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
						{trackCountLabel(tracks.length)} · {formatTime(totalSec)}
					</span>
				)}
				<SearchInput
					value={query}
					onChange={setQuery}
					label="Search tracks"
					className="ml-auto w-40 min-w-0"
				/>
			</div>
			<Separator />

			{isEmpty ? (
				<EmptyState
					framed
					icon={<Music className="h-9 w-9" />}
					title="Your library is empty — add songs or drop audio files anywhere."
				/>
			) : noMatches ? (
				<EmptyState
					icon={<Search className="h-8 w-8" />}
					title={`No tracks match “${query}”.`}
				/>
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
							const isCurrent =
								ownsQueue && track.id === state.currentTrack?.id;
							// The row's server-side facts: its id (playlist membership
							// is keyed by it) and its artist names. Both keep their
							// identity until the next library refresh, so handing them
							// to a memoized row costs it no re-renders.
							const remote = libraryService.getRemote(track.id);
							return (
								<li key={track.id}>
									<LibraryTrackRow
										track={track}
										index={index}
										artistNames={remote?.artists}
										isCurrent={isCurrent}
										showBars={isCurrent && state.isPlaying}
										playlists={playlists.playlists}
										artists={artists.artists}
										onPlay={playTrackAt}
										onEdit={actions.edit}
										onDelete={actions.remove}
										onTogglePlaylist={actions.togglePlaylist}
										onNewPlaylist={actions.newPlaylist}
										onOpenArtist={navigationService.openArtist}
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
