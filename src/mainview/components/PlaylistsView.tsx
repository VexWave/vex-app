import { useState } from "react";
import {
	ListMusic,
	Loader2,
	Pause,
	Pencil,
	Play,
	Plus,
	Trash2,
} from "lucide-react";
import { playlistQueueContext, playlistService } from "@/api/PlaylistService";
import { PlaylistCover } from "@/components/PlaylistCover";
import { PlaylistDetail } from "@/components/PlaylistDetail";
import { PlaylistDialog } from "@/components/PlaylistDialog";
import { PlaylistsErrorBanner } from "@/components/PlaylistsErrorBanner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useLibrary } from "@/hooks/useLibrary";
import { usePlayer } from "@/hooks/usePlayer";
import { usePlaylists } from "@/hooks/usePlaylists";
import { cn } from "@/lib/utils";
import type { RemotePlaylist } from "../../shared/rpcSchema";
import type { Track } from "@/player/types";

/**
 * One grid card. Click opens the playlist; hover reveals play/edit/delete.
 * While the playlist is playing, the play button stays visible as a pause
 * button (and `onPlay` toggles instead of restarting — see the grid).
 */
function PlaylistCard({
	playlist,
	tracks,
	playing,
	onOpen,
	onPlay,
	onEdit,
	onDelete,
}: {
	playlist: RemotePlaylist;
	tracks: Track[];
	playing: boolean;
	onOpen: () => void;
	onPlay: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onOpen}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen();
				}
			}}
			className="group relative flex cursor-pointer flex-col gap-2 rounded-lg p-3 transition-colors hover:bg-accent"
		>
			<div className="relative">
				<PlaylistCover
					playlist={playlist}
					tracks={tracks}
					className="aspect-square w-full"
				/>
				{tracks.length > 0 && (
					<Button
						size="icon"
						className={cn(
							"absolute bottom-2 right-2 h-9 w-9 rounded-full shadow-md transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
							playing ? "opacity-100" : "opacity-0",
						)}
						aria-label={
							playing ? `Pause ${playlist.name}` : `Play ${playlist.name}`
						}
						onClick={(e) => {
							e.stopPropagation();
							onPlay();
						}}
					>
						{playing ? (
							<Pause className="h-4 w-4 fill-current" />
						) : (
							<Play className="h-4 w-4 fill-current" />
						)}
					</Button>
				)}
			</div>
			<div className="min-w-0">
				<p className="truncate text-sm font-medium">{playlist.name}</p>
				<p className="truncate text-xs text-muted-foreground">
					{tracks.length} {tracks.length === 1 ? "track" : "tracks"}
				</p>
			</div>
			<div className="absolute right-1 top-1 flex rounded-md bg-background/70 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7"
					aria-label={`Edit ${playlist.name}`}
					onClick={(e) => {
						e.stopPropagation();
						onEdit();
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
						onDelete();
					}}
				>
					<Trash2 className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
}

export function PlaylistsView() {
	const { playlists: state } = usePlaylists();
	// The grid's play buttons mirror playback: a playing playlist shows pause.
	const { state: playerState } = usePlayer();
	// Subscribe to the library so the grid's collages and track counts
	// re-render when it loads/changes (tracksOf reads its snapshot).
	useLibrary();
	const [openId, setOpenId] = useState<number | null>(null);
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

	// Always render the *fresh* snapshot of the opened playlist; if it was
	// deleted (here or server-side), fall back to the grid.
	const open =
		openId !== null
			? (state.playlists.find((playlist) => playlist.id === openId) ?? null)
			: null;

	const firstLoad = state.loading && state.playlists.length === 0;

	return (
		<div className="flex h-full flex-col">
			{open ? (
				<PlaylistDetail
					playlist={open}
					onBack={() => setOpenId(null)}
					onEdit={() => openEdit(open)}
				/>
			) : (
				<>
					<div className="flex items-center justify-between px-4 py-2.5">
						<h2 className="text-sm font-semibold">Playlists</h2>
						<Button variant="secondary" size="sm" onClick={openCreate}>
							<Plus className="h-4 w-4" />
							New playlist
						</Button>
					</div>
					<Separator />

					<PlaylistsErrorBanner error={state.error} />

					{firstLoad ? (
						<div className="flex flex-1 items-center justify-center text-muted-foreground">
							<Loader2 className="h-6 w-6 animate-spin" />
						</div>
					) : state.playlists.length === 0 ? (
						<div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
							<ListMusic className="h-12 w-12" />
							<p className="text-sm">
								No playlists yet — create one to get started.
							</p>
						</div>
					) : (
						<ScrollArea className="min-h-0 flex-1">
							<ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 p-4">
								{state.playlists.map((playlist) => {
									const tracks = playlistService.tracksOf(playlist);
									// The queue already mirrors this playlist → its button
									// shows pause (playOrToggle resumes instead of
									// restarting from the top).
									const ownsQueue =
										playerState.queueContextId ===
										playlistQueueContext(playlist.id);
									return (
										<li key={playlist.id}>
											<PlaylistCard
												playlist={playlist}
												tracks={tracks}
												playing={ownsQueue && playerState.isPlaying}
												onOpen={() => setOpenId(playlist.id)}
												onPlay={() => playlistService.playOrToggle(playlist)}
												onEdit={() => openEdit(playlist)}
												onDelete={() => setPendingDelete(playlist)}
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

			<Dialog
				open={pendingDelete !== null}
				onOpenChange={(next) => {
					if (!next) setPendingDelete(null);
				}}
			>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>Delete playlist?</DialogTitle>
						<DialogDescription>
							Removes “{pendingDelete?.name}” from the server. Its tracks stay
							in the library.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setPendingDelete(null)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								if (!pendingDelete) return;
								void playlistService.remove(pendingDelete.id);
								if (openId === pendingDelete.id) setOpenId(null);
								setPendingDelete(null);
							}}
						>
							Delete
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
