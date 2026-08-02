import { LogOut, RefreshCw } from "lucide-react";
import { artistService } from "@/api/ArtistService";
import { libraryService } from "@/api/LibraryService";
import { AddTracksButton } from "@/components/AddTracksButton";
import { HeaderAction } from "@/components/HeaderAction";
import { ImportUrlButton } from "@/components/ImportUrlButton";
import { Logo } from "@/components/Logo";
import { ViewSwitch } from "@/components/ViewSwitch";
import { useLibrary } from "@/hooks/useLibrary";
import { useSession } from "@/hooks/useSession";
import { cn } from "@/lib/utils";

/**
 * The app bar: the wordmark, the switch between the app's sections, and the
 * actions. The right side rests as a row of bare glyphs — each names itself by
 * growing leftwards on hover (`HeaderAction`) — and holds refresh, the two ways
 * you hand the app a file (paste a link, pick a file), and logging out. Nothing
 * that is somewhere to *be* belongs in that row; a place is a section, and
 * reaching it is the switch's business.
 *
 * **Log out lives here rather than in the sidebar** because it ends the session
 * the whole app runs on, and the sidebar belongs to one section — a section
 * declaring no aside would otherwise have no way to log out at all.
 *
 * The switch is centred in the *window* only if the flanks are equal tracks,
 * which is what the three columns buy. They differ in what they may give up: the
 * wordmark's track is `minmax(0,…)` and truncates, while the actions' is a plain
 * `1fr` — that is `minmax(auto,1fr)`, so it never falls below the width of the
 * resting glyph row. A narrow enough window therefore pushes the switch a few
 * pixels off centre rather than clipping a button nobody can then press.
 */
export function AppHeader() {
	const { library } = useLibrary();
	const { service: session } = useSession();

	// Both stores back one of the main views, so a single refresh keeps the
	// track list and the artist list in step with each other.
	const refresh = () => {
		void libraryService.refresh();
		void artistService.refresh();
	};

	return (
		<header className="grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_auto_1fr] items-center gap-4 border-b bg-gradient-to-b from-card to-card/30 px-5">
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

			<ViewSwitch />

			{/* Two boxes for one row, because they hold opposite ends of the same
			    problem. This outer one carries no `min-w-0` and no `overflow`: both
			    would waive the track's automatic minimum (an overflow box is a
			    scroll container, and scroll containers have none), and that minimum
			    is what keeps the resting glyphs from being squeezed.

			    The inner one clips. A revealed label can be wider than the track —
			    on a HiDPI display the CSS viewport can sit near 600px, where half of
			    what is left over is narrower than "Add songs" — and these buttons
			    don't shrink, so without clipping the row would spill out of its own
			    column and paint across the switch beside it. justify-end so the
			    labels grow into the empty space to the left, and the buttons sit
			    flush so the pointer never crosses a dead zone between them. */}
			<div>
				<div className="flex items-center justify-end overflow-hidden">
					<HeaderAction
						icon={<RefreshCw className={cn(library.loading && "animate-spin")} />}
						label="Refresh"
						disabled={library.loading}
						onClick={refresh}
					/>
					<ImportUrlButton />
					<AddTracksButton />
					{/* Ends the session everything else here depends on, so it is last
					    and answers hover in the destructive colour rather than the
					    row's. */}
					<HeaderAction
						icon={<LogOut />}
						label="Log out"
						className="hover:bg-destructive/10 hover:text-destructive"
						onClick={() => void session.logout()}
					/>
				</div>
			</div>
		</header>
	);
}
