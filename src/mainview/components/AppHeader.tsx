import { RefreshCw } from "lucide-react";
import { artistService } from "@/api/ArtistService";
import { libraryService } from "@/api/LibraryService";
import { AddTracksButton } from "@/components/AddTracksButton";
import { HeaderAction } from "@/components/HeaderAction";
import { ImportUrlButton } from "@/components/ImportUrlButton";
import { Logo } from "@/components/Logo";
import { useLibrary } from "@/hooks/useLibrary";
import { cn } from "@/lib/utils";

/**
 * The app bar: the wordmark on the left, refresh and the two "get music in"
 * actions on the right. The right side rests as a row of bare glyphs — each
 * names itself by growing leftwards on hover (`HeaderAction`).
 */
export function AppHeader() {
	const { library } = useLibrary();

	// Both stores back one of the main views, so a single refresh keeps the
	// track list and the artist list in step with each other.
	const refresh = () => {
		void libraryService.refresh();
		void artistService.refresh();
	};

	return (
		<header className="flex h-16 shrink-0 items-center gap-4 border-b bg-gradient-to-b from-card to-card/30 px-5">
			<div className="flex min-w-0 items-center gap-3">
				{/* The mark sits on its own tile so the logo reads as an app icon
				    rather than a loose graphic next to the wordmark. */}
				<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-muted/80 to-muted/20 shadow-sm ring-1 ring-inset ring-border/70">
					<Logo className="h-6 w-6" />
				</div>
				{/* font-semibold matches the one weight the wordmark face ships. */}
				<h1 className="truncate font-wordmark text-xl font-semibold tracking-tight">
					VexWave
				</h1>
			</div>

			{/* justify-end so the growing labels eat into the empty space to the
			    left instead of pushing the row past the window edge. */}
			<div className="ml-auto flex min-w-0 items-center justify-end gap-1">
				<HeaderAction
					icon={<RefreshCw className={cn(library.loading && "animate-spin")} />}
					label="Refresh"
					disabled={library.loading}
					onClick={refresh}
				/>
				<ImportUrlButton />
				<AddTracksButton />
			</div>
		</header>
	);
}
