import { useEffect, useMemo, useState } from "react";
import { ListMusic, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { openIdOf } from "@/api/NavigationService";
import { playlistQueueContext, playlistService } from "@/api/PlaylistService";
import { CollectionCard } from "@/components/CollectionCard";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner } from "@/components/ErrorBanner";
import { PlaylistCover } from "@/components/PlaylistCover";
import { PlaylistDetail } from "@/components/PlaylistDetail";
import { PlaylistDialog } from "@/components/PlaylistDialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useLibrary } from "@/hooks/useLibrary";
import { useNavigation } from "@/hooks/useNavigation";
import { usePlayer } from "@/hooks/usePlayer";
import { usePlaylists } from "@/hooks/usePlaylists";
import { trackCountLabel } from "@/lib/utils";
import type { RemotePlaylist } from "../../shared/rpcSchema";

export function PlaylistsView() {
	const { playlists: state } = usePlaylists();
	const { view, service: navigation } = useNavigation();
	// The grid's play buttons mirror playback: a playing playlist shows pause.
	const { state: playerState } = usePlayer();
	// The collages and track counts are joined against the library.
	const { library } = useLibrary();
	const [dialogOpen, setDialogOpen] = useState(false);
	// The playlist being edited, or null when the dialog is in "create" mode.
	const [editing, setEditing] = useState<RemotePlaylist | null>(null);
	const [pendingDelete, setPendingDelete] = useState<RemotePlaylist | null>(
		null,
	);

	const openCreate = () => {
		setEditing(null);
		setDialogOpen(true);
	};
	const openEdit = (playlist: RemotePlaylist) => {
		setEditing(playlist);
		setDialogOpen(true);
	};

	// Joined once for the whole grid — per-card joins would be redone on every
	// player timeupdate. `library.tracks` is in the deps purely as the
	// recompute trigger for the snapshot tracksOf reads.
	const tracksByPlaylist = useMemo(
		() =>
			new Map(
				state.playlists.map((playlist) => [
					playlist.id,
					playlistService.tracksOf(playlist),
				]),
			),
		[state.playlists, library.tracks],
	);

	// Always render the *fresh* snapshot of the opened playlist; if it was
	// deleted (here or server-side), fall back to the grid.
	const openId = openIdOf(view);
	const open =
		openId !== null
			? (state.playlists.find((playlist) => playlist.id === openId) ?? null)
			: null;

	// The open id lives in the app's navigation state, so when the playlist
	// behind it vanishes (deleted by another client, or the id outlived its
	// session) the navigation state must be told — otherwise the sidebar
	// would keep marking a detail view the grid has already replaced.
	useEffect(() => {
		if (openId !== null && open === null) navigation.openPlaylist(null);
	}, [openId, open, navigation]);

	const firstLoad = state.loading && state.playlists.length === 0;

	return (
		<div className="flex h-full flex-col">
			{open ? (
				<PlaylistDetail
					playlist={open}
					onBack={() => navigation.openPlaylist(null)}
					onEdit={() => openEdit(open)}
				/>
			) : (
				<>
					<div className="flex items-center gap-3 px-4 py-2.5">
						<h2 className="shrink-0 text-sm font-semibold">Playlists</h2>
						<Button
							variant="secondary"
							size="sm"
							className="ml-auto"
							onClick={openCreate}
						>
							<Plus className="h-4 w-4" />
							New playlist
						</Button>
					</div>
					<Separator />

					<ErrorBanner error={state.error} className="border-b" />

					{firstLoad ? (
						<div className="flex flex-1 items-center justify-center text-muted-foreground">
							<Loader2 className="h-6 w-6 animate-spin" />
						</div>
					) : state.playlists.length === 0 ? (
						<div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
							<div className="flex h-20 w-20 items-center justify-center rounded-full border border-dashed">
								<ListMusic className="h-9 w-9" />
							</div>
							<p className="text-sm">
								No playlists yet — create one to get started.
							</p>
						</div>
					) : (
						<ScrollArea className="min-h-0 flex-1">
							{/* Track sizing shared with the artists grid — see there. */}
							<ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2 p-4">
								{state.playlists.map((playlist) => {
									const tracks = tracksByPlaylist.get(playlist.id) ?? [];
									// The queue already mirrors this playlist → its button
									// shows pause (playOrToggle resumes instead of
									// restarting from the top).
									const ownsQueue =
										playerState.queueContextId ===
										playlistQueueContext(playlist.id);
									const playing = ownsQueue && playerState.isPlaying;
									return (
										<li key={playlist.id}>
											<CollectionCard
												artwork={
													<PlaylistCover
														playlist={playlist}
														tracks={tracks}
														className="aspect-square w-full"
													/>
												}
												name={playlist.name}
												meta={trackCountLabel(tracks.length)}
												ownsQueue={ownsQueue}
												playing={playing}
												playLabel={
													playing
														? `Pause ${playlist.name}`
														: `Play ${playlist.name}`
												}
												onOpen={() => navigation.openPlaylist(playlist.id)}
												onPlay={
													tracks.length > 0
														? () => playlistService.playOrToggle(playlist)
														: undefined
												}
												actions={
													<>
														<Button
															variant="ghost"
															size="icon"
															className="h-7 w-7"
															aria-label={`Edit ${playlist.name}`}
															onClick={(e) => {
																e.stopPropagation();
																openEdit(playlist);
															}}
														>
															<Pencil className="h-4 w-4" />
														</Button>
														<Button
															variant="ghost"
															size="icon"
															className="h-7 w-7"
															aria-label={`Delete ${playlist.name}`}
															onClick={(e) => {
																e.stopPropagation();
																setPendingDelete(playlist);
															}}
														>
															<Trash2 className="h-4 w-4" />
														</Button>
													</>
												}
											/>
										</li>
									);
								})}
							</ul>
						</ScrollArea>
					)}
				</>
			)}

			<PlaylistDialog
				playlist={editing}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
			/>

			<ConfirmDialog
				open={pendingDelete !== null}
				onOpenChange={(next) => {
					if (!next) setPendingDelete(null);
				}}
				title="Delete playlist?"
				description={`Removes “${pendingDelete?.name}” from the server. Its tracks stay in the library.`}
				onConfirm={() => {
					if (!pendingDelete) return;
					void playlistService.remove(pendingDelete.id);
					// Back to the grid right away — the vanished-playlist effect
					// would only catch up after the refetch.
					if (openId === pendingDelete.id) navigation.openPlaylist(null);
				}}
			/>
		</div>
	);
}
