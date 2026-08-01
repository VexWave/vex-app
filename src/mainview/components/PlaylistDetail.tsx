import { useCallback, useMemo, useState } from "react";
import {
	DndContext,
	KeyboardSensor,
	PointerSensor,
	closestCenter,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
	restrictToParentElement,
	restrictToVerticalAxis,
} from "@dnd-kit/modifiers";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ListMusic, ListPlus, Pencil } from "lucide-react";
import { libraryService } from "@/api/LibraryService";
import { navigationService } from "@/api/NavigationService";
import { playlistQueueContext, playlistService } from "@/api/PlaylistService";
import { AddTracksDialog } from "@/components/AddTracksDialog";
import { CollectionHeader } from "@/components/CollectionHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { PlaylistCover } from "@/components/PlaylistCover";
import { PlaylistTrackRow } from "@/components/PlaylistTrackRow";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useArtists } from "@/hooks/useArtists";
import { useLibrary } from "@/hooks/useLibrary";
import { usePlayer } from "@/hooks/usePlayer";
import { usePlaylists } from "@/hooks/usePlaylists";
import { useTrackActions } from "@/hooks/useTrackActions";
import { formatTime, trackCountLabel } from "@/lib/utils";
import type { RemotePlaylist } from "../../shared/rpcSchema";

/*
 * Sensor options live out here because `useSensor` memoizes on the options
 * object's identity: fresh literals would hand DndContext a new sensor array
 * every render, which changes the context value every row's `useSortable`
 * subscribes to. Context updates bypass memo(), so on a view that re-renders
 * once a second while playing that would rebuild every row on every tick.
 */
// A small distance before a drag begins, so pressing the grip and letting go
// stays a click rather than a zero-length reorder.
const POINTER_OPTIONS = { activationConstraint: { distance: 4 } };
const KEYBOARD_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates };

/** The opened playlist: banner with cover/meta/actions plus its track rows. */
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
	// For the rows' "Go to artist" entry: the names a track carries have to be
	// resolved against the artist list to become somewhere to navigate.
	const { artists } = useArtists();
	const [addOpen, setAddOpen] = useState(false);
	// Edit/delete actions and the dialogs they open, rendered once for the whole
	// list; the row menus just call into them.
	const actions = useTrackActions();

	// Join the ordered trackIds against the library. `position` is the index
	// into trackIds (only used for the move-bound checks); the row index is
	// the position in the *joined* list (what playback addresses) — they
	// diverge only while a dangling id awaits the next playlists refresh.
	const rows = useMemo(() => {
		const byId = new Map(library.tracks.map((track) => [track.id, track]));
		return playlist.trackIds.flatMap((serverId, position) => {
			const track = byId.get(serverId);
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
		(serverId: string, direction: -1 | 1) =>
			playlistService.moveTrack(playlist.id, serverId, direction),
		[playlist.id],
	);
	const removeRow = useCallback(
		(serverId: string) =>
			void playlistService.removeTracks(playlist.id, [serverId]),
		[playlist.id],
	);

	const sensors = useSensors(
		useSensor(PointerSensor, POINTER_OPTIONS),
		useSensor(KeyboardSensor, KEYBOARD_OPTIONS),
	);
	const sortableIds = useMemo(() => rows.map((row) => row.serverId), [rows]);
	const handleDragEnd = useCallback(
		({ active, over }: DragEndEvent) => {
			if (!over || active.id === over.id) return;
			// dnd-kit widens a sortable id to `string | number`; these came from
			// `sortableIds`, so they are the rows' own track ids.
			playlistService.reorderTrack(
				playlist.id,
				String(active.id),
				String(over.id),
			);
		},
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
	const ownsQueue = state.queueContextId === playlistQueueContext(playlist.id);
	const playing = ownsQueue && state.isPlaying;

	return (
		<div className="flex h-full flex-col">
			<CollectionHeader
				onBack={onBack}
				parentLabel="Playlists"
				artwork={
					<PlaylistCover
						playlist={playlist}
						tracks={rows.map((row) => row.track)}
						className="h-16 w-16 shrink-0"
						iconClassName="h-7 w-7"
					/>
				}
				title={playlist.name}
				meta={`${trackCountLabel(rows.length)}${
					rows.length > 0 ? ` · ${formatTime(totalSec)}` : ""
				}`}
				playing={playing}
				playLabel={
					playing ? `Pause ${playlist.name}` : `Play ${playlist.name}`
				}
				playDisabled={rows.length === 0}
				onPlay={() => playlistService.playOrToggle(playlist)}
				actions={
					<>
						<Button
							variant="ghost"
							size="icon"
							className="h-8 w-8"
							aria-label={`Edit ${playlist.name}`}
							onClick={onEdit}
						>
							<Pencil className="h-4 w-4" />
						</Button>
						<Button
							variant="secondary"
							size="sm"
							className="rounded-full px-4"
							onClick={() => setAddOpen(true)}
						>
							<ListPlus className="h-4 w-4" />
							Add tracks
						</Button>
					</>
				}
			/>

			<ErrorBanner error={playlists.error} className="border-b" />

			{rows.length === 0 ? (
				<EmptyState
					icon={<ListMusic className="h-12 w-12" />}
					title="This playlist is empty — add tracks from the library."
				/>
			) : (
				<ScrollArea className="min-h-0 flex-1">
					{/* Rows may only trade places within the list, so the drag is
					    pinned to the vertical axis and to the <ul>'s box. */}
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						modifiers={[restrictToVerticalAxis, restrictToParentElement]}
						onDragEnd={handleDragEnd}
					>
						<SortableContext
							items={sortableIds}
							strategy={verticalListSortingStrategy}
						>
							<ul className="flex flex-col gap-1 p-2">
								{rows.map(({ track, serverId, position }, rowIndex) => {
									// A track is in a playlist at most once, so within the
									// owning playlist the id match is unambiguous.
									const isCurrent =
										ownsQueue && track.id === state.currentTrack?.id;
									return (
										<PlaylistTrackRow
											key={track.id}
											track={track}
											rowIndex={rowIndex}
											serverId={serverId}
											// Keeps its identity until the next library
											// refresh, so the memoized row is unaffected.
											artistNames={libraryService.getRemote(track.id)?.artists}
											artists={artists.artists}
											isCurrent={isCurrent}
											showBars={isCurrent && state.isPlaying}
											canMoveUp={position > 0}
											canMoveDown={position < playlist.trackIds.length - 1}
											onPlay={playRow}
											onEdit={actions.edit}
											onMove={moveRow}
											onRemove={removeRow}
											onDelete={actions.remove}
											onOpenArtist={navigationService.openArtist}
										/>
									);
								})}
							</ul>
						</SortableContext>
					</DndContext>
				</ScrollArea>
			)}

			<AddTracksDialog
				playlist={playlist}
				open={addOpen}
				onOpenChange={setAddOpen}
			/>

			{actions.dialogs}
		</div>
	);
}
