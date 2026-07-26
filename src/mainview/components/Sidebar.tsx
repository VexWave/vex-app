import { ListMusic, LibraryBig, LogOut, Users } from "lucide-react";
import { playlistQueueContext } from "@/api/PlaylistService";
import { SidebarPlaylistItem } from "@/components/SidebarPlaylistItem";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useArtists } from "@/hooks/useArtists";
import { useLibrary } from "@/hooks/useLibrary";
import { useNavigation } from "@/hooks/useNavigation";
import { usePlayer } from "@/hooks/usePlayer";
import { usePlaylists } from "@/hooks/usePlaylists";
import { useSession } from "@/hooks/useSession";
import { cn } from "@/lib/utils";
import type { MainViewName } from "@/api/NavigationService";

const NAV_ITEMS = [
	{ view: "library", label: "Library", icon: LibraryBig },
	{ view: "playlists", label: "Playlists", icon: ListMusic },
	{ view: "artists", label: "Artists", icon: Users },
] as const;

export function Sidebar() {
	const { service } = useSession();
	const { view, service: navigation } = useNavigation();
	const { library } = useLibrary();
	const { playlists } = usePlaylists();
	const { artists } = useArtists();
	// For the per-playlist rows: which playlist owns the queue, and whether
	// audio is running (now-playing ring + play/pause button state).
	const { state: playerState } = usePlayer();

	// Badge counts come straight from the stores the views render, so the
	// sidebar can never disagree with the list next to it.
	const counts: Record<MainViewName, number> = {
		library: library.tracks.length,
		playlists: playlists.playlists.length,
		artists: artists.artists.length,
	};

	// While a playlist's detail view is open, its own sidebar row is the active
	// item instead of the "Playlists" nav entry — exactly one sidebar item
	// mirrors what the main area shows. Artists have no per-artist rows, so
	// their nav entry stays active with one opened.
	const openPlaylistId = view.name === "playlists" ? view.openId : null;

	return (
		<div className="flex h-full flex-col overflow-hidden rounded-xl border bg-gradient-to-b from-card to-card/40 shadow-sm">
			<nav className="flex flex-col gap-1 p-2" aria-label="Main">
				{NAV_ITEMS.map((item) => {
					const active =
						item.view === view.name &&
						(item.view !== "playlists" || openPlaylistId === null);
					const count = counts[item.view];
					return (
						<button
							key={item.view}
							type="button"
							className={cn(
								"group relative flex w-full items-center gap-3 rounded-lg py-2 pl-4 pr-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
								active
									? "bg-accent text-accent-foreground"
									: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
							)}
							aria-current={active ? "page" : undefined}
							onClick={() => navigation.show(item.view)}
						>
							{/* Accent rail on the active item. Always mounted so it can
							    grow/fade between views instead of popping in. */}
							<span
								aria-hidden="true"
								className={cn(
									"absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200",
									active
										? "scale-y-100 opacity-100"
										: "scale-y-0 opacity-0",
								)}
							/>
							<item.icon
								className={cn(
									"h-4 w-4 shrink-0 transition-colors",
									active
										? "text-primary"
										: "text-muted-foreground group-hover:text-foreground",
								)}
							/>
							{item.label}
							{/* h-5 + a matching min-width makes one- and two-digit counts
							    an exact circle; only 3+ digits stretch it into a pill.
							    leading-none keeps the glyph from pushing the box taller
							    than it is wide. */}
							{count > 0 && (
								<span
									className={cn(
										"ml-auto inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-[11px] font-medium leading-none tabular-nums transition-colors",
										active
											? "bg-primary/15 text-foreground"
											: "bg-muted/70 text-muted-foreground",
									)}
								>
									{count}
								</span>
							)}
						</button>
					);
				})}
			</nav>

			{/* Every playlist gets its own entry below the main nav: click opens
			    it, the button at its right edge plays/pauses it, and a purple
			    ring orbits the cover of the one the current track comes from.
			    Hidden while there are none — the "Playlists" nav item already
			    covers the empty state. The heading sits outside the scroll area
			    so it stays put while the list scrolls. */}
			{playlists.playlists.length > 0 && (
				<div className="flex min-h-0 flex-1 flex-col border-t">
					<h3
						id="sidebar-playlists-heading"
						className="px-4 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
					>
						Playlists
					</h3>
					<ScrollArea className="min-h-0 flex-1">
						<nav
							className="flex flex-col gap-0.5 p-2 pt-0"
							aria-labelledby="sidebar-playlists-heading"
						>
							{playlists.playlists.map((playlist) => {
								const ownsQueue =
									playerState.queueContextId ===
									playlistQueueContext(playlist.id);
								return (
									<SidebarPlaylistItem
										key={playlist.id}
										playlist={playlist}
										active={playlist.id === openPlaylistId}
										ownsQueue={ownsQueue}
										playing={ownsQueue && playerState.isPlaying}
										// Bound singleton method — stable across renders, so
										// the memoized rows skip the sidebar's per-timeupdate
										// re-renders.
										onOpen={navigation.openPlaylist}
									/>
								);
							})}
						</nav>
					</ScrollArea>
				</div>
			)}

			{/* Pinned to the bottom; logout just drops the local token and returns
			    to the login screen (the server session isn't revoked). */}
			<div className="mt-auto border-t p-2">
				<button
					type="button"
					className="flex w-full items-center gap-3 rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					onClick={() => void service.logout()}
				>
					<LogOut className="h-4 w-4 shrink-0" />
					Log out
				</button>
			</div>
		</div>
	);
}
