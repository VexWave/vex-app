import {
	AlertCircle,
	CloudUpload,
	Loader2,
	Music,
	Play,
	Volume2,
	X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePlayer } from "@/hooks/usePlayer";
import { useUploads } from "@/hooks/useUploads";
import { cn, formatTime } from "@/lib/utils";
import type { UploadEntry } from "@/api/UploadService";

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

export function TrackList() {
	const { state, controller } = usePlayer();
	const uploads = useUploads();

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
		<ScrollArea className="h-full">
			<ul className="flex flex-col gap-1 p-2">
				{state.tracks.map((track, index) => {
					const isCurrent = index === state.currentIndex;
					return (
						<li key={track.id}>
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
								<UploadIndicator upload={uploads[track.id]} />
								<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
									{formatTime(track.durationSec)}
								</span>
								<Button
									variant="ghost"
									size="icon"
									className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
									aria-label={`Remove ${track.title}`}
									onClick={(e) => {
										e.stopPropagation();
										controller.removeTrack(index);
									}}
								>
									<X className="h-4 w-4" />
								</Button>
							</div>
						</li>
					);
				})}
			</ul>
		</ScrollArea>
	);
}
