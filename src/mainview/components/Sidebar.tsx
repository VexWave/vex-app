import { ListMusic, LogOut, Users } from "lucide-react";
import { useArtists } from "@/hooks/useArtists";
import { usePlayer } from "@/hooks/usePlayer";
import { useSession } from "@/hooks/useSession";
import { cn } from "@/lib/utils";

/** The views the main content area can show; the sidebar switches them. */
export type MainView = "library" | "artists";

const NAV_ITEMS = [
	{ view: "library", label: "Library", icon: ListMusic },
	{ view: "artists", label: "Artists", icon: Users },
] as const;

export function Sidebar({
	view,
	onViewChange,
}: {
	view: MainView;
	onViewChange: (view: MainView) => void;
}) {
	const { service } = useSession();
	const { state } = usePlayer();
	const { artists } = useArtists();

	// Badge counts come straight from the two stores the views render, so the
	// sidebar can never disagree with the list next to it.
	const counts: Record<MainView, number> = {
		library: state.tracks.length,
		artists: artists.artists.length,
	};

	return (
		<div className="flex h-full flex-col overflow-hidden rounded-xl border bg-gradient-to-b from-card to-card/40 shadow-sm">
			<nav className="flex flex-col gap-1 p-2" aria-label="Main">
				{NAV_ITEMS.map((item) => {
					const active = item.view === view;
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
							onClick={() => onViewChange(item.view)}
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
