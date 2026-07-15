import { ListMusic, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
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
	return (
		<div className="h-full rounded-xl border bg-card">
			<nav className="flex flex-col gap-1 p-2" aria-label="Main">
				{NAV_ITEMS.map((item) => {
					const active = item.view === view;
					return (
						<Button
							key={item.view}
							variant="ghost"
							className={cn(
								"justify-start",
								active && "bg-accent text-accent-foreground",
							)}
							aria-current={active ? "page" : undefined}
							onClick={() => onViewChange(item.view)}
						>
							<item.icon className="h-4 w-4" />
							{item.label}
						</Button>
					);
				})}
			</nav>
		</div>
	);
}
