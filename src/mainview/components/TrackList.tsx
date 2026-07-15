import { useState } from "react";
import {
	AlertCircle,
	Cloud,
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
		<div className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left opacity-80">
			<div className="relative h-10 w-10 shrink-0 overflow-hidden rounded bg-muted">
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

	if (state.tracks.length === 0 && uploads.length === 0) {
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
					{uploads.map((upload) => (
						<li key={upload.id}>
							<PendingUploadRow upload={upload} />
						</li>
					))}
					{state.tracks.map((track, index) => {
						const isCurrent = index === state.currentIndex;
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
											<span title="Streams from the server" className="shrink-0">
												<Cloud className="h-3.5 w-3.5 text-muted-foreground" />
											</span>
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
										<ContextMenuItem onSelect={() => setManageTrack(track)}>
											<Users className="h-4 w-4" />
											Artists…
										</ContextMenuItem>
										<ContextMenuSeparator />
										<ContextMenuItem
											className="text-destructive focus:text-destructive"
											onSelect={() => setDeleteTrack(track)}
										>
											<Trash2 className="h-4 w-4" />
											Delete from server
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
