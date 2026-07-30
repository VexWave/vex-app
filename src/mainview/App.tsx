import { useState, type ComponentType, type DragEvent } from "react";
import { uploadService } from "@/api/UploadService";
import { AppHeader } from "@/components/AppHeader";
import { ArtistsView } from "@/components/ArtistsView";
import { BinarySetupScreen } from "@/components/BinarySetupScreen";
import { DiscoverView } from "@/components/DiscoverView";
import { ErrorBanner } from "@/components/ErrorBanner";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { PlayerBar } from "@/components/PlayerBar";
import { PlaylistsView } from "@/components/PlaylistsView";
import { Sidebar } from "@/components/Sidebar";
import { TrackList } from "@/components/TrackList";
import { UploadReviewDialog } from "@/components/UploadReviewDialog";
import { YtDlpUpdateBanner } from "@/components/YtDlpUpdateBanner";
import { useBinaries } from "@/hooks/useBinaries";
import { useLibrary } from "@/hooks/useLibrary";
import { useNavigation } from "@/hooks/useNavigation";
import { usePlayer } from "@/hooks/usePlayer";
import { useSession } from "@/hooks/useSession";
import type { MainViewName } from "@/api/NavigationService";

/**
 * What each top-level view renders. A table rather than a conditional chain
 * because it is exhaustive over MainViewName: a view added to the union without a
 * component here is a compile error, where a chain's last `else` would quietly
 * render the wrong view.
 */
const VIEWS: Record<MainViewName, ComponentType> = {
	library: TrackList,
	discover: DiscoverView,
	playlists: PlaylistsView,
	artists: ArtistsView,
};

function App() {
	const { state } = usePlayer();
	const { session } = useSession();
	const { binaries } = useBinaries();
	// LibraryService fetches the server library per login and clears the queue
	// on logout; the component only renders its error state.
	const { library } = useLibrary();
	// Which view the main area shows, and which item it has opened — owned by
	// NavigationService so any component can navigate (see useNavigation).
	const { view } = useNavigation();
	const MainViewComponent = VIEWS[view.name];
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
			<AppHeader />
			<YtDlpUpdateBanner />

			{/* Always-visible sidebar: this is a fixed-size desktop window, and on
			    HiDPI displays the CSS viewport can sit below Tailwind's `md`
			    breakpoint — a responsive-hidden sidebar would be unreachable. */}
			<main className="grid min-h-0 flex-1 grid-cols-[200px_1fr] gap-4 p-4">
				<Sidebar />
				{/* min-w-0: grid items default to min-width:auto, so one nowrap
				    track title would widen the 1fr column past the window. */}
				<div className="min-h-0 min-w-0 overflow-hidden rounded-xl border bg-gradient-to-b from-card to-card/40 shadow-sm">
					<MainViewComponent />
				</div>
			</main>

			<ErrorBanner error={state.error} className="border-t" />
			<ErrorBanner
				error={library.error && `Server library: ${library.error}`}
				className="border-t"
			/>

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
