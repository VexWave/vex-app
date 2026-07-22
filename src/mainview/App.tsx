import { useState, type DragEvent } from "react";
import { AlertCircle } from "lucide-react";
import { uploadService } from "@/api/UploadService";
import { AddTracksButton } from "@/components/AddTracksButton";
import { ArtistsView } from "@/components/ArtistsView";
import { BinarySetupScreen } from "@/components/BinarySetupScreen";
import { ImportUrlButton } from "@/components/ImportUrlButton";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { PlayerBar } from "@/components/PlayerBar";
import { Sidebar, type MainView } from "@/components/Sidebar";
import { TrackList } from "@/components/TrackList";
import { UploadReviewDialog } from "@/components/UploadReviewDialog";
import { YtDlpUpdateBanner } from "@/components/YtDlpUpdateBanner";
import { Separator } from "@/components/ui/separator";
import { useBinaries } from "@/hooks/useBinaries";
import { useLibrary } from "@/hooks/useLibrary";
import { usePlayer } from "@/hooks/usePlayer";
import { useSession } from "@/hooks/useSession";

function App() {
	const { state } = usePlayer();
	const { session } = useSession();
	const { binaries } = useBinaries();
	// LibraryService fetches the server library per login and clears the queue
	// on logout; the component only renders its error state.
	const { library } = useLibrary();
	const [view, setView] = useState<MainView>("library");
	const [isDragging, setIsDragging] = useState(false);

	// Dropped files are uploaded to the server; they re-enter the queue as
	// streaming tracks once the upload completes.
	const handleDrop = (e: DragEvent) => {
		e.preventDefault();
		setIsDragging(false);
		uploadService.enqueue(e.dataTransfer.files);
	};

	// Hard gate before login: the helper binaries (yt-dlp/ffmpeg/deno) must
	// exist before anything else, so a fresh machine sets up first.
	if (binaries.phase !== "ready") return <BinarySetupScreen />;

	// A persisted token is still being replayed — show a splash rather than
	// flashing the login form before the restore resolves.
	if (session.restoring) {
		return (
			<div className="flex h-screen items-center justify-center bg-background text-foreground">
				<Logo className="h-14 w-14 animate-pulse" />
			</div>
		);
	}

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
			onDrop={handleDrop}
		>
			<header className="flex items-center justify-between px-6 py-4">
				<div className="flex items-center gap-2">
					<Logo className="h-6 w-6" />
					<h1 className="text-xl font-bold tracking-tight">VexWave</h1>
				</div>
				<div className="flex items-center gap-2">
					<ImportUrlButton />
					<AddTracksButton />
				</div>
			</header>
			<Separator />
			<YtDlpUpdateBanner />

			{/* Always-visible sidebar: this is a fixed-size desktop window, and on
			    HiDPI displays the CSS viewport can sit below Tailwind's `md`
			    breakpoint — a responsive-hidden sidebar would be unreachable. */}
			<main className="grid min-h-0 flex-1 grid-cols-[200px_1fr] gap-4 p-4">
				<Sidebar view={view} onViewChange={setView} />
				{/* min-w-0: grid items default to min-width:auto, so one nowrap
				    track title would widen the 1fr column past the window. */}
				<div className="min-h-0 min-w-0 overflow-hidden rounded-xl border bg-gradient-to-b from-card to-card/40 shadow-sm">
					{view === "library" ? <TrackList /> : <ArtistsView />}
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

			<UploadReviewDialog />

			{isDragging && (
				<div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-4 border-dashed border-primary/60 bg-background/80">
					<p className="text-lg font-medium">Drop audio files to add them</p>
				</div>
			)}
		</div>
	);
}

export default App;
