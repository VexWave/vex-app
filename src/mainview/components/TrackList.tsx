import { useState } from "react";
import {
	AlertCircle,
	Cloud,
	CloudUpload,
	EllipsisVertical,
	Loader2,
	Music,
	Play,
	Trash2,
	Users,
	Volume2,
} from "lucide-react";
import { libraryService } from "@/api/LibraryService";
import { ManageArtistsDialog } from "@/components/ManageArtistsDialog";
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
import { usePlayer } from "@/hooks/usePlayer";
import { useUploads } from "@/hooks/useUploads";
import { cn, formatTime } from "@/lib/utils";
import type { UploadEntry } from "@/api/UploadService";
import type { Track } from "@/player/types";

function UploadIndicator({ upload }: { upload: UploadEntry | undefined }) {
	if (!upload) return null;
	if (upload.status === "uploading") {
		return (
			<span title="Uploading to server…" className="shrink-0">
				<Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
			</span>
		);
	}
	if (upload.status === "done") {
		return (
			<span title="Uploaded to server" className="shrink-0">
				<CloudUpload className="h-3.5 w-3.5 text-muted-foreground" />
			</span>
		);
	}
	return (
		<span title={upload.error ?? "Upload failed"} className="shrink-0">
			<AlertCircle className="h-3.5 w-3.5 text-destructive" />
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

export function TrackList() {
	const { state, controller } = usePlayer();
	const uploads = useUploads();
	// Both dialogs are rendered once for the whole list; the context menu sets
	// which track they target.
	const [manageTrack, setManageTrack] = useState<Track | null>(null);
	const [deleteTrack, setDeleteTrack] = useState<Track | null>(null);

	// Local tracks are removed from the queue only; remote (server) tracks are
	// deleted on the server after a confirmation, since that can't be undone.
	const requestDelete = (track: Track, index: number) => {
		if (track.origin === "remote") setDeleteTrack(track);
		else controller.removeTrack(index);
	};

	if (state.tracks.length === 0) {
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
					{state.tracks.map((track, index) => {
						const isCurrent = index === state.currentIndex;
						const isRemote = track.origin === "remote";
						return (
							<li key={track.id}>
								<ContextMenu>
									<ContextMenuTrigger asChild>
										<div
											role="button"
											tabIndex={0}
											onClick={() => controller.playTrackAt(index)}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													controller.playTrackAt(index);
												}
											}}
											className={cn(
												"group flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent",
												isCurrent && "bg-accent",
											)}
										>
											<div className="relative h-10 w-10 shrink-0 overflow-hidden rounded bg-muted">
												{track.coverUrl ? (
													<img
														src={track.coverUrl}
														alt=""
														className="h-full w-full object-cover"
													/>
												) : (
													<Music className="absolute inset-0 m-auto h-5 w-5 text-muted-foreground" />
												)}
												<div
													className={cn(
														"absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100",
														isCurrent && state.isPlaying && "opacity-100",
													)}
												>
													{isCurrent && state.isPlaying ? (
														<Volume2 className="h-4 w-4 text-white" />
													) : (
														<Play className="h-4 w-4 text-white" />
													)}
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
											{isRemote ? (
												<span title="Streams from the server" className="shrink-0">
													<Cloud className="h-3.5 w-3.5 text-muted-foreground" />
												</span>
											) : (
												<UploadIndicator upload={uploads[track.id]} />
											)}
											<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
												{formatTime(track.durationSec)}
											</span>
											<Button
												variant="ghost"
												size="icon"
												className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
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
										<ContextMenuItem
											disabled={!isRemote}
											onSelect={() => setManageTrack(track)}
										>
											<Users className="h-4 w-4" />
											Artists…
										</ContextMenuItem>
										<ContextMenuSeparator />
										<ContextMenuItem
											className="text-destructive focus:text-destructive"
											onSelect={() => requestDelete(track, index)}
										>
											<Trash2 className="h-4 w-4" />
											{isRemote ? "Delete from server" : "Remove from queue"}
										</ContextMenuItem>
									</ContextMenuContent>
								</ContextMenu>
							</li>
						);
					})}
				</ul>
			</ScrollArea>

			<ManageArtistsDialog
				track={manageTrack}
				open={manageTrack !== null}
				onOpenChange={(open) => {
					if (!open) setManageTrack(null);
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
