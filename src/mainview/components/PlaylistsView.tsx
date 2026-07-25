import { memo, useCallback, useMemo, useState } from "react";
import {
	AlertCircle,
	ArrowDown,
	ArrowUp,
	Check,
	ChevronLeft,
	EllipsisVertical,
	ListMusic,
	ListPlus,
	Loader2,
	Music,
	Pause,
	Pencil,
	Play,
	Plus,
	Search,
	Trash2,
	X,
} from "lucide-react";
import { libraryService, trackIdForServerId } from "@/api/LibraryService";
import { playlistQueueContext, playlistService } from "@/api/PlaylistService";
import { EditTrackDialog } from "@/components/EditTrackDialog";
import { PlaylistDialog } from "@/components/PlaylistDialog";
import { NowPlayingBars, openRowMenu } from "@/components/TrackList";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useLibrary } from "@/hooks/useLibrary";
import { usePlayer } from "@/hooks/usePlayer";
import { usePlaylists } from "@/hooks/usePlaylists";
import { cn, formatTime } from "@/lib/utils";
import type { RemotePlaylist } from "../../shared/rpcSchema";
import type { Track } from "@/player/types";

/**
 * A playlist's cover: the uploaded image when it has one, else a collage of
 * the first (up to four) distinct track covers — 1 fills the square, 2 sit
 * side by side, 3 are two on top and one across the bottom, 4 take a corner
 * each. The collage needs no server round-trip — it reuses cover URLs the
 * library already has.
 */
function PlaylistCover({
	playlist,
	tracks,
	className,
	iconClassName,
}: {
	playlist: RemotePlaylist;
	tracks: Track[];
	className?: string;
	iconClassName?: string;
}) {
	const covers = useMemo(() => {
		if (playlist.imageUrl) return [];
		const distinct: string[] = [];
		for (const track of tracks) {
			if (track.coverUrl && !distinct.includes(track.coverUrl)) {
				distinct.push(track.coverUrl);
				if (distinct.length === 4) break;
			}
		}
		return distinct;
	}, [playlist.imageUrl, tracks]);

	return (
		<div
			className={cn(
				"relative overflow-hidden rounded-md bg-muted shadow-sm ring-1 ring-inset ring-border/60",
				className,
			)}
		>
			{playlist.imageUrl ? (
				<img
					src={playlist.imageUrl}
					alt=""
					className="h-full w-full object-cover"
				/>
			) : covers.length === 1 ? (
				<img src={covers[0]} alt="" className="h-full w-full object-cover" />
			) : covers.length > 1 ? (
				// 2 covers → side-by-side halves; 3 → two on top, one across the
				// bottom; 4 → one per corner.
				<div
					className={cn(
						// Explicit fr rows — the images size themselves h-full against
						// the row track, which an implicit `auto` row can't provide.
						"grid h-full w-full grid-cols-2",
						covers.length >= 3 ? "grid-rows-2" : "grid-rows-1",
					)}
				>
					{covers.map((url, index) => (
						<img
							key={url}
							src={url}
							alt=""
							className={cn(
								"h-full w-full object-cover",
								covers.length === 3 && index === 2 && "col-span-2",
							)}
						/>
					))}
				</div>
			) : (
				<ListMusic
					className={cn(
						"absolute inset-0 m-auto text-muted-foreground",
						iconClassName ?? "h-8 w-8",
					)}
				/>
			)}
		</div>
	);
}

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

/**
 * Searchable library picker for editing the open playlist's membership. A
 * track can be in a playlist at most once, so each row is a toggle: clicking
 * adds the track, clicking again removes it. Every click applies immediately,
 * so the dialog can stay open while several tracks are added.
 */
function AddTracksDialog({
	playlist,
	open,
	onOpenChange,
}: {
	playlist: RemotePlaylist | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { library } = useLibrary();
	const [query, setQuery] = useState("");

	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return library.tracks;
		return library.tracks.filter(
			(track) =>
				track.title.toLowerCase().includes(needle) ||
				track.artist?.toLowerCase().includes(needle),
		);
	}, [library.tracks, query]);

	const isIn = (track: Track): boolean => {
		const serverId = libraryService.getRemote(track.id)?.id;
		if (serverId === undefined || !playlist) return false;
		return playlist.trackIds.includes(serverId);
	};

	const toggle = (track: Track) => {
		const serverId = libraryService.getRemote(track.id)?.id;
		if (serverId === undefined || !playlist) return;
		void (isIn(track)
			? playlistService.removeTracks(playlist.id, [serverId])
			: playlistService.addTracks(playlist.id, [serverId]));
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) setQuery("");
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Add tracks</DialogTitle>
					<DialogDescription>
						Add library tracks to “{playlist?.name}”; click an added track to
						remove it again.
					</DialogDescription>
				</DialogHeader>
				<div className="relative">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search tracks"
						aria-label="Search tracks"
						className="h-8 pl-8 text-xs"
					/>
				</div>
				<ScrollArea className="h-72">
					{visible.length === 0 ? (
						<div className="flex h-full items-center justify-center py-10 text-sm text-muted-foreground">
							{library.tracks.length === 0
								? "The library is empty."
								: `No tracks match “${query}”.`}
						</div>
					) : (
						<ul className="flex flex-col gap-1 pr-3">
							{visible.map((track) => {
								const included = isIn(track);
								return (
									<li key={track.id}>
										<div className="flex w-full items-center gap-3 rounded-lg py-1.5 pl-2 pr-1">
											<div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-inset ring-border/60">
												{track.coverUrl ? (
													<img
														src={track.coverUrl}
														alt=""
														className="h-full w-full object-cover"
													/>
												) : (
													<Music className="absolute inset-0 m-auto h-4 w-4 text-muted-foreground" />
												)}
											</div>
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-medium">
													{track.title}
												</p>
												<p className="truncate text-xs text-muted-foreground">
													{track.artist ?? "Unknown artist"}
												</p>
											</div>
											<Button
												variant="ghost"
												size="icon"
												className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
												aria-label={
													included
														? `Remove ${track.title}`
														: `Add ${track.title}`
												}
												onClick={() => toggle(track)}
											>
												{included ? (
													<Check className="h-4 w-4 text-primary" />
												) : (
													<Plus className="h-4 w-4" />
												)}
											</Button>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</ScrollArea>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Playlist-level errors (fetch, delete, and fire-and-forget membership
 * edits). Rendered in the grid *and* the detail view — membership edits
 * happen in the detail view, so their failures must be visible there.
 */
function PlaylistsErrorBanner({ error }: { error: string | null }) {
	if (!error) return null;
	return (
		<div className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
			<AlertCircle className="h-4 w-4 shrink-0" />
			<span className="truncate">{error}</span>
		</div>
	);
}

/**
 * One row of the open playlist's ordered track list. Memoized for the same
 * reason as TrackRow: the detail view re-renders on every player timeupdate,
 * and this keeps those ticks from rebuilding every row (incl. a Radix
 * ContextMenu apiece). All props are referentially stable across ticks except
 * the booleans on rows entering/leaving the current-track state.
 */
const PlaylistTrackRow = memo(function PlaylistTrackRow({
	track,
	rowIndex,
	serverId,
	isCurrent,
	showBars,
	canMoveUp,
	canMoveDown,
	onPlay,
	onEdit,
	onMove,
	onRemove,
}: {
	track: Track;
	rowIndex: number;
	/** Server-side track id — membership edits are addressed by it. */
	serverId: number;
	isCurrent: boolean;
	showBars: boolean;
	canMoveUp: boolean;
	canMoveDown: boolean;
	onPlay: (rowIndex: number) => void;
	onEdit: (track: Track) => void;
	onMove: (serverId: number, direction: -1 | 1) => void;
	onRemove: (serverId: number) => void;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					role="button"
					tabIndex={0}
					onClick={() => onPlay(rowIndex)}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onPlay(rowIndex);
						}
					}}
					className={cn(
						"group relative flex w-full cursor-pointer items-center gap-3 rounded-lg py-2 pl-3 pr-2.5 text-left transition-colors",
						isCurrent ? "bg-accent" : "hover:bg-accent/60",
					)}
				>
					<span
						aria-hidden="true"
						className={cn(
							"absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-opacity",
							isCurrent ? "opacity-100" : "opacity-0",
						)}
					/>
					<span className="flex w-5 shrink-0 justify-center text-xs tabular-nums text-muted-foreground">
						{showBars ? <NowPlayingBars /> : rowIndex + 1}
					</span>
					<div
						className={cn(
							"relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-muted shadow-sm ring-1 ring-inset ring-border/60 transition-shadow",
							isCurrent && "ring-primary/40",
						)}
					>
						{track.coverUrl ? (
							<img
								src={track.coverUrl}
								alt=""
								className="h-full w-full object-cover"
							/>
						) : (
							<Music className="absolute inset-0 m-auto h-5 w-5 text-muted-foreground" />
						)}
						<div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
							<Play className="h-4 w-4 fill-white text-white" />
						</div>
					</div>
					<div className="min-w-0 flex-1">
						<p
							className={cn(
								"truncate text-sm font-medium",
								isCurrent && "text-primary",
							)}
						>
							{track.title}
						</p>
						<p className="truncate text-xs text-muted-foreground">
							{track.artist ?? "Unknown artist"}
						</p>
					</div>
					<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
						{formatTime(track.durationSec)}
					</span>
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
						aria-label={`More options for ${track.title}`}
						onClick={(e) => {
							e.stopPropagation();
							openRowMenu(e.currentTarget);
						}}
					>
						<EllipsisVertical className="h-4 w-4" />
					</Button>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-52">
				<ContextMenuItem onSelect={() => onEdit(track)}>
					<Pencil className="h-4 w-4" />
					Edit…
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem
					disabled={!canMoveUp}
					onSelect={() => onMove(serverId, -1)}
				>
					<ArrowUp className="h-4 w-4" />
					Move up
				</ContextMenuItem>
				<ContextMenuItem
					disabled={!canMoveDown}
					onSelect={() => onMove(serverId, 1)}
				>
					<ArrowDown className="h-4 w-4" />
					Move down
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem
					className="text-destructive focus:text-destructive"
					onSelect={() => onRemove(serverId)}
				>
					<X className="h-4 w-4" />
					Remove from playlist
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
});

/** The opened playlist: header with cover/meta/actions plus its track rows. */
function PlaylistDetail({
	playlist,
	onBack,
	onEdit,
}: {
	playlist: RemotePlaylist;
	onBack: () => void;
	onEdit: () => void;
}) {
	const { state, controller } = usePlayer();
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
	// becomes a pause/resume toggle instead of restarting from the top.
	const ownsQueue =
		controller.queueContextId === playlistQueueContext(playlist.id);

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
					onClick={() =>
						ownsQueue ? controller.togglePlay() : playlistService.play(playlist)
					}
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
							// A track is in a playlist at most once, so the id match is
							// unambiguous no matter where playback was started from.
							const isCurrent = track.id === state.currentTrack?.id;
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

export function PlaylistsView() {
	const { playlists: state } = usePlaylists();
	// The grid's play buttons mirror playback: a playing playlist shows pause.
	const { state: playerState, controller } = usePlayer();
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
									// The queue already mirrors this playlist → the button
									// pauses/resumes instead of restarting from the top.
									const ownsQueue =
										controller.queueContextId ===
										playlistQueueContext(playlist.id);
									return (
										<li key={playlist.id}>
											<PlaylistCard
												playlist={playlist}
												tracks={tracks}
												playing={ownsQueue && playerState.isPlaying}
												onOpen={() => setOpenId(playlist.id)}
												onPlay={() =>
													ownsQueue
														? controller.togglePlay()
														: playlistService.play(playlist)
												}
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

