import { ListMusic, LogOut, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
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
	return (
		<div className="flex h-full flex-col rounded-xl border bg-card">
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
			{/* Pinned to the bottom; logout just drops the local token and returns
			    to the login screen (the server session isn't revoked). */}
			<Button
				variant="ghost"
				className="mx-2 mb-2 mt-auto justify-start text-muted-foreground"
				onClick={() => void service.logout()}
			>
				<LogOut className="h-4 w-4" />
				Log out
			</Button>
		</div>
	);
}
