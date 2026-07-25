import { memo, useCallback, useMemo, useState } from "react";
import {
	AlertCircle,
	CircleArrowDown,
	EllipsisVertical,
	Link2,
	ListMusic,
	Loader2,
	Music,
	Pencil,
	Play,
	Plus,
	Search,
	Trash2,
	X,
} from "lucide-react";
import { importService } from "@/api/ImportService";
import { LIBRARY_QUEUE_CONTEXT, libraryService } from "@/api/LibraryService";
import { playlistService } from "@/api/PlaylistService";
import { uploadService } from "@/api/UploadService";
import { EditTrackDialog } from "@/components/EditTrackDialog";
import { PlaylistDialog } from "@/components/PlaylistDialog";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
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
import { useImports } from "@/hooks/useImports";
import { useLibrary } from "@/hooks/useLibrary";
import { usePlayer } from "@/hooks/usePlayer";
import { usePlaylists } from "@/hooks/usePlaylists";
import { useTrackCache } from "@/hooks/useTrackCache";
import { useUploads } from "@/hooks/useUploads";
import { cn, formatMb, formatTime } from "@/lib/utils";
import type { ImportJob } from "@/api/ImportService";
import type { UploadItem } from "@/api/UploadService";
import type { RemotePlaylist } from "../../shared/rpcSchema";
import type { Track } from "@/player/types";

/**
 * A file that is being uploaded to the server. It has no queue row yet — it
 * reappears as a streaming track once the upload finishes — so it renders as
 * a non-interactive placeholder showing progress or the failure reason.
 */
function PendingUploadRow({ upload }: { upload: UploadItem }) {
	const failed = upload.status === "error";
	return (
		<div className="flex w-full items-center gap-3 rounded-lg py-2 pl-3 pr-2.5 text-left opacity-80">
			{/* Spacer matching the track rows' index column, so covers line up. */}
			<span className="w-5 shrink-0" aria-hidden="true" />
			<div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-muted shadow-sm ring-1 ring-inset ring-border/60">
				<Music className="absolute inset-0 m-auto h-5 w-5 text-muted-foreground" />
			</div>
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium">{upload.title}</p>
				<p
					className={cn(
						"truncate text-xs text-muted-foreground",
						failed && "text-destructive",
					)}
				>
					{failed ? (upload.error ?? "Upload failed") : "Uploading to server…"}
				</p>
			</div>
			{failed ? (
				<>
					<AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
						aria-label="Dismiss failed upload"
						onClick={() => uploadService.dismiss(upload.id)}
					>
						<X className="h-4 w-4" />
					</Button>
				</>
			) : (
				<Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
			)}
		</div>
	);
}

/** Human status line for a URL-import row, per step. */
function importStatus(job: ImportJob): string {
	switch (job.step) {
		case "starting":
			return "Preparing download…";
		case "downloading":
			return job.totalBytes
				? `Downloading… ${Math.min(100, Math.round((job.receivedBytes / job.totalBytes) * 100))}%`
				: `Downloading… ${formatMb(job.receivedBytes)}`;
		case "converting":
			return "Converting to MP3…";
		case "staging":
			return "Almost done…";
		case "error":
			return job.error ?? "Import failed";
	}
}

/**
 * A URL import in progress. Like uploads it has no queue row yet — the
 * finished file goes through the upload-review dialog and lands as a streaming
 * track — so it renders as a placeholder with live download progress. Failed
 * imports keep their row (with the yt-dlp error) until dismissed.
 */
function PendingImportRow({ job }: { job: ImportJob }) {
	const failed = job.step === "error";
	const percent =
		job.step === "downloading" && job.totalBytes
			? Math.min(100, (job.receivedBytes / job.totalBytes) * 100)
			: null;
	return (
		<div className="flex w-full items-center gap-3 rounded-lg py-2 pl-3 pr-2.5 text-left opacity-80">
			{/* Spacer matching the track rows' index column, so covers line up. */}
			<span className="w-5 shrink-0" aria-hidden="true" />
			<div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-muted shadow-sm ring-1 ring-inset ring-border/60">
				<Link2 className="absolute inset-0 m-auto h-5 w-5 text-muted-foreground" />
			</div>
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium">{job.title ?? job.url}</p>
				<p
					className={cn(
						"truncate text-xs text-muted-foreground",
						failed && "text-destructive",
					)}
				>
					{importStatus(job)}
				</p>
				{percent !== null && (
					<div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
						<div
							className="h-full rounded-full bg-primary transition-[width] duration-200"
							style={{ width: `${percent}%` }}
						/>
					</div>
				)}
			</div>
			{failed ? (
				<>
					<AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
						aria-label="Dismiss failed import"
						onClick={() => importService.dismiss(job.id)}
					>
						<X className="h-4 w-4" />
					</Button>
				</>
			) : (
				<Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
			)}
		</div>
	);
}

// Negative delays stagger the bars into different phases so they read as an
// equalizer immediately, without a synchronized "all bars rise together" start.
const BAR_DELAYS = ["-0.4s", "-0.15s", "-0.6s", "-0.25s"];

/**
 * Little equalizer whose bars bounce to mark the track that's currently
 * playing (the caller only renders it while playback is active). Decorative
 * only (the row is already highlighted), so it's hidden from assistive tech
 * and honours prefers-reduced-motion.
 */
export function NowPlayingBars() {
	return (
		<span
			className="flex h-4 w-4 shrink-0 items-end justify-center gap-[2px]"
			aria-hidden="true"
		>
			{BAR_DELAYS.map((delay, i) => (
				<span
					key={i}
					className="h-full w-[2px] origin-bottom rounded-full bg-primary animate-equalize motion-reduce:animate-none"
					style={{ animationDelay: delay }}
				/>
			))}
		</span>
	);
}

/**
 * Marks a track whose full audio sits in the bun memory cache — replaying or
 * seeking through it is instant, no server round-trip.
 */
function CachedBadge() {
	return (
		<span
			className="shrink-0 text-primary/70"
			title="Downloaded — plays instantly"
			aria-label="Downloaded — plays instantly"
			role="img"
		>
			<CircleArrowDown className="h-3.5 w-3.5" />
		</span>
	);
}

/**
 * Open the row's context menu from a left-click on the kebab button: Radix's
 * ContextMenuTrigger listens for `contextmenu`, so we synthesize one anchored
 * at the button. Native right-click on the row keeps working unchanged.
 */
export function openRowMenu(button: HTMLElement) {
	const rect = button.getBoundingClientRect();
	button.dispatchEvent(
		new MouseEvent("contextmenu", {
			bubbles: true,
			clientX: rect.left + rect.width / 2,
			clientY: rect.bottom,
		}),
	);
}

/**
 * One playable library row. Memoized: TrackList re-renders on every player
 * timeupdate and on every import/upload progress tick, and without this each
 * of those rebuilt every row (incl. a Radix ContextMenu apiece). All props are
 * referentially stable across those ticks except the booleans, which only
 * change for rows entering/leaving the current-track or cached state (the
 * `playlists` array and `onPlay` only change on the rare library/playlist
 * refresh).
 */
const TrackRow = memo(function TrackRow({
	track,
	index,
	isCurrent,
	showBars,
	isCached,
	playlists,
	onPlay,
	onEdit,
	onDelete,
	onAddToPlaylist,
	onNewPlaylist,
}: {
	track: Track;
	index: number;
	isCurrent: boolean;
	showBars: boolean;
	isCached: boolean;
	playlists: RemotePlaylist[];
	onPlay: (index: number) => void;
	onEdit: (track: Track) => void;
	onDelete: (track: Track) => void;
	onAddToPlaylist: (track: Track, playlistId: number) => void;
	onNewPlaylist: (track: Track) => void;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					role="button"
					tabIndex={0}
					onClick={() => onPlay(index)}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onPlay(index);
						}
					}}
					className={cn(
						"group relative flex w-full cursor-pointer items-center gap-3 rounded-lg py-2 pl-3 pr-2.5 text-left transition-colors",
						isCurrent ? "bg-accent" : "hover:bg-accent/60",
					)}
				>
					{/* Same accent rail the sidebar uses for its active item. */}
					<span
						aria-hidden="true"
						className={cn(
							"absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-opacity",
							isCurrent ? "opacity-100" : "opacity-0",
						)}
					/>
					{/* Queue position, replaced by the equalizer on the playing row. */}
					<span className="flex w-5 shrink-0 justify-center text-xs tabular-nums text-muted-foreground">
						{showBars ? <NowPlayingBars /> : index + 1}
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
							{track.album ? ` · ${track.album}` : ""}
						</p>
					</div>
					{isCached && <CachedBadge />}
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
			<ContextMenuContent className="w-44">
				<ContextMenuItem onSelect={() => onEdit(track)}>
					<Pencil className="h-4 w-4" />
					Edit…
				</ContextMenuItem>
				<ContextMenuSub>
					<ContextMenuSubTrigger className="gap-2 [&>svg]:size-4 [&>svg]:shrink-0">
						<ListMusic className="h-4 w-4" />
						Add to playlist
					</ContextMenuSubTrigger>
					<ContextMenuSubContent className="w-44">
						<ContextMenuItem onSelect={() => onNewPlaylist(track)}>
							<Plus className="h-4 w-4" />
							New playlist…
						</ContextMenuItem>
						{playlists.length > 0 && <ContextMenuSeparator />}
						{playlists.map((playlist) => (
							<ContextMenuItem
								key={playlist.id}
								onSelect={() => onAddToPlaylist(track, playlist.id)}
							>
								<span className="truncate">{playlist.name}</span>
							</ContextMenuItem>
						))}
					</ContextMenuSubContent>
				</ContextMenuSub>
				<ContextMenuSeparator />
				<ContextMenuItem
					className="text-destructive focus:text-destructive"
					onSelect={() => onDelete(track)}
				>
					<Trash2 className="h-4 w-4" />
					Delete from server
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
});

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
	const cachedIds = useTrackCache();
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
	const addToPlaylist = useCallback((track: Track, playlistId: number) => {
		const serverId = libraryService.getRemote(track.id)?.id;
		if (serverId === undefined) return;
		void playlistService.addTracks(playlistId, [serverId]);
	}, []);

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
							// The cache reports server ids; map the track id back to one.
							const serverId = libraryService.getRemote(track.id)?.id;
							// The queue may hold a playlist, so "current" is by track
							// id — the highlight follows the playing track wherever it
							// was started from.
							const isCurrent = track.id === state.currentTrack?.id;
							return (
								<li key={track.id}>
									<TrackRow
										track={track}
										index={index}
										isCurrent={isCurrent}
										showBars={isCurrent && state.isPlaying}
										isCached={serverId !== undefined && cachedIds.has(serverId)}
										playlists={playlists.playlists}
										onPlay={playTrackAt}
										onEdit={setEditTrack}
										onDelete={setDeleteTrack}
										onAddToPlaylist={addToPlaylist}
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

			<Dialog
				open={deleteTrack !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteTrack(null);
				}}
			>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>Delete track?</DialogTitle>
						<DialogDescription>
							Permanently deletes “{deleteTrack?.title}” from the server.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setDeleteTrack(null)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								if (deleteTrack) void libraryService.removeTrack(deleteTrack.id);
								setDeleteTrack(null);
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
