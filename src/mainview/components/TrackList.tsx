import { memo, useCallback, useState } from "react";
import {
	AlertCircle,
	CircleArrowDown,
	EllipsisVertical,
	Link2,
	Loader2,
	Music,
	Pencil,
	Play,
	Trash2,
	X,
} from "lucide-react";
import { importService } from "@/api/ImportService";
import { libraryService } from "@/api/LibraryService";
import { EditTrackDialog } from "@/components/EditTrackDialog";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { useImports } from "@/hooks/useImports";
import { usePlayer } from "@/hooks/usePlayer";
import { useTrackCache } from "@/hooks/useTrackCache";
import { useUploads } from "@/hooks/useUploads";
import { cn, formatMb, formatTime } from "@/lib/utils";
import type { ImportJob } from "@/api/ImportService";
import type { UploadItem } from "@/api/UploadService";
import type { Track } from "@/player/types";

/**
 * A file that is being uploaded to the server. It has no queue row yet — it
 * reappears as a streaming track once the upload finishes — so it renders as
 * a non-interactive placeholder showing progress or the failure reason.
 */
function PendingUploadRow({ upload }: { upload: UploadItem }) {
	const failed = upload.status === "error";
	return (
		<div className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left opacity-80">
			<div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-inset ring-border/60">
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
				<AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
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
		<div className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left opacity-80">
			<div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-inset ring-border/60">
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
function NowPlayingBars() {
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
function openRowMenu(button: HTMLElement) {
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
 * referentially stable except the booleans, which only change for rows
 * entering/leaving the current-track or cached state.
 */
const TrackRow = memo(function TrackRow({
	track,
	index,
	isCurrent,
	showBars,
	isCached,
	onPlay,
	onEdit,
	onDelete,
}: {
	track: Track;
	index: number;
	isCurrent: boolean;
	showBars: boolean;
	isCached: boolean;
	onPlay: (index: number) => void;
	onEdit: (track: Track) => void;
	onDelete: (track: Track) => void;
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
						"group flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
						isCurrent ? "bg-accent" : "hover:bg-accent/60",
					)}
				>
					<div
						className={cn(
							"relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-inset ring-border/60 transition-shadow",
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
					{showBars && <NowPlayingBars />}
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

export function TrackList() {
	const { state, controller } = usePlayer();
	const { uploads } = useUploads();
	const { imports } = useImports();
	const cachedIds = useTrackCache();
	// Both dialogs are rendered once for the whole list; the context menu sets
	// which track they target.
	const [editTrack, setEditTrack] = useState<Track | null>(null);
	const [deleteTrack, setDeleteTrack] = useState<Track | null>(null);
	// Stable identity so it never busts TrackRow's memo.
	const playTrackAt = useCallback(
		(index: number) => controller.playTrackAt(index),
		[controller],
	);

	if (
		state.tracks.length === 0 &&
		uploads.length === 0 &&
		imports.length === 0
	) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
				<Music className="h-12 w-12" />
				<p className="text-sm">
					Your queue is empty — add songs or drop audio files anywhere.
				</p>
			</div>
		);
	}

	return (
		<>
			<ScrollArea className="h-full">
				<ul className="flex flex-col gap-1 p-2">
					{imports.map((job) => (
						<li key={job.id}>
							<PendingImportRow job={job} />
						</li>
					))}
					{uploads.map((upload) => (
						<li key={upload.id}>
							<PendingUploadRow upload={upload} />
						</li>
					))}
					{state.tracks.map((track, index) => {
						// The cache reports server ids; map the queue id back to one.
						const serverId = libraryService.getRemote(track.id)?.id;
						return (
							<li key={track.id}>
								<TrackRow
									track={track}
									index={index}
									isCurrent={index === state.currentIndex}
									showBars={index === state.currentIndex && state.isPlaying}
									isCached={serverId !== undefined && cachedIds.has(serverId)}
									onPlay={playTrackAt}
									onEdit={setEditTrack}
									onDelete={setDeleteTrack}
								/>
							</li>
						);
					})}
				</ul>
			</ScrollArea>

			<EditTrackDialog
				track={editTrack}
				open={editTrack !== null}
				onOpenChange={(open) => {
					if (!open) setEditTrack(null);
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
		</>
	);
}
