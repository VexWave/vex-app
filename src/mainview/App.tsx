import { useState, type DragEvent } from "react";
import { AlertCircle, Trash2 } from "lucide-react";
import { uploadService } from "@/api/UploadService";
import { AddTracksButton } from "@/components/AddTracksButton";
import { LoginScreen } from "@/components/LoginScreen";
import { NowPlaying } from "@/components/NowPlaying";
import { PlayerBar } from "@/components/PlayerBar";
import { TrackList } from "@/components/TrackList";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useLibrary } from "@/hooks/useLibrary";
import { usePlayer } from "@/hooks/usePlayer";
import { useSession } from "@/hooks/useSession";
import { LocalTrackLoader } from "@/player/LocalTrackLoader";

const loader = new LocalTrackLoader();

function App() {
	const { state, controller } = usePlayer();
	const { session } = useSession();
	// LibraryService fetches the server library per login and drops remote
	// tracks on logout; the component only renders its error state.
	const { library } = useLibrary();
	const [isDragging, setIsDragging] = useState(false);

	const handleDrop = async (e: DragEvent) => {
		e.preventDefault();
		setIsDragging(false);
		const tracks = await loader.loadFiles(e.dataTransfer.files);
		controller.addTracks(tracks);
		uploadService.enqueue(tracks);
	};

	// Blocking login: the player UI is only reachable with a live session.
	// The player singleton survives this unmount, so a mid-session 401
	// doesn't stop audio or lose the queue.
	if (session.status !== "loggedIn") return <LoginScreen />;

	return (
		<div
			className="flex h-screen flex-col bg-background text-foreground"
			onDragOver={(e) => {
				e.preventDefault();
				setIsDragging(true);
			}}
			onDragLeave={(e) => {
				if (e.currentTarget === e.target) setIsDragging(false);
			}}
			onDrop={(e) => void handleDrop(e)}
		>
			<header className="flex items-center justify-between px-6 py-4">
				<h1 className="text-xl font-bold tracking-tight">Music Player</h1>
				<div className="flex items-center gap-2">
					{state.tracks.length > 0 && (
						<Button
							variant="ghost"
							size="icon"
							aria-label="Clear queue"
							onClick={() => controller.clearQueue()}
						>
							<Trash2 className="h-4 w-4" />
						</Button>
					)}
					<AddTracksButton />
				</div>
			</header>
			<Separator />

			<main className="grid min-h-0 flex-1 gap-4 p-4 md:grid-cols-[280px_1fr]">
				<div className="hidden md:block">
					<NowPlaying />
				</div>
				<div className="min-h-0 rounded-xl border bg-card">
					<TrackList />
				</div>
			</main>

			{state.error && (
				<div className="flex items-center gap-2 border-t bg-destructive/10 px-4 py-2 text-sm text-destructive">
					<AlertCircle className="h-4 w-4 shrink-0" />
					<span className="truncate">{state.error}</span>
				</div>
			)}
			{library.error && (
				<div className="flex items-center gap-2 border-t bg-destructive/10 px-4 py-2 text-sm text-destructive">
					<AlertCircle className="h-4 w-4 shrink-0" />
					<span className="truncate">Server library: {library.error}</span>
				</div>
			)}

			<PlayerBar />

			{isDragging && (
				<div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-4 border-dashed border-primary/60 bg-background/80">
					<p className="text-lg font-medium">Drop audio files to add them</p>
				</div>
			)}
		</div>
	);
}

export default App;
