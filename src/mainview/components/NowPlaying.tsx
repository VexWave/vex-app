import { Music } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { usePlayer } from "@/hooks/usePlayer";

export function NowPlaying() {
	const { state } = usePlayer();
	const track = state.currentTrack;

	return (
		<Card className="h-full">
			<CardContent className="flex h-full flex-col items-center justify-center gap-4 p-6">
				<div className="flex aspect-square w-full max-w-56 items-center justify-center overflow-hidden rounded-lg bg-muted shadow-lg">
					{track?.coverUrl ? (
						<img
							src={track.coverUrl}
							alt={`Cover of ${track.title}`}
							className="h-full w-full object-cover"
						/>
					) : (
						<Music className="h-16 w-16 text-muted-foreground" />
					)}
				</div>
				<div className="w-full text-center">
					<p className="truncate text-lg font-semibold">
						{track ? track.title : "Nothing playing"}
					</p>
					<p className="truncate text-sm text-muted-foreground">
						{track?.artist ?? (track ? "Unknown artist" : "Add songs to start")}
					</p>
					{track?.album && (
						<p className="mt-1 truncate text-xs text-muted-foreground/70">
							{track.album}
						</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
