import type { ReactNode } from "react";
import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The edit/delete pair a card reveals in its corner. Both stop the click from
 * reaching the card behind them, which would otherwise open the collection on
 * the way to its dialog.
 */
export function CollectionCardActions({
	name,
	onEdit,
	onDelete,
}: {
	/** The collection's name, for the buttons' accessible labels. */
	name: string;
	onEdit: () => void;
	onDelete: () => void;
}) {
	return (
		<>
			<Button
				variant="ghost"
				size="icon"
				className="h-7 w-7"
				aria-label={`Edit ${name}`}
				onClick={(e) => {
					e.stopPropagation();
					onEdit();
				}}
			>
				<Pencil className="h-4 w-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				className="h-7 w-7"
				aria-label={`Delete ${name}`}
				onClick={(e) => {
					e.stopPropagation();
					onDelete();
				}}
			>
				<Trash2 className="h-4 w-4" />
			</Button>
		</>
	);
}

/**
 * One card in a collection grid — a playlist, an artist. Artwork with a
 * play/pause button that fades in over it, the collection's name and a meta
 * line, plus hover-revealed actions in the corner; clicking anywhere else
 * opens the collection.
 *
 * `shape` follows the artwork the caller renders: round artwork (an artist)
 * centres its label and tucks the play button inside the circle, square
 * artwork (a playlist) keeps both flush with the cover's edge.
 */
export function CollectionCard({
	artwork,
	name,
	meta,
	shape = "square",
	ownsQueue,
	playing,
	playLabel,
	onOpen,
	onPlay,
	actions,
}: {
	artwork: ReactNode;
	name: string;
	meta: string;
	shape?: "square" | "round";
	/** The play queue mirrors this collection — tints the name, like the sidebar. */
	ownsQueue?: boolean;
	/** ownsQueue and audio is running — the button shows pause and stays visible. */
	playing?: boolean;
	playLabel: string;
	onOpen: () => void;
	/** Omitted for an empty collection: there is nothing to start. */
	onPlay?: () => void;
	actions?: ReactNode;
}) {
	const round = shape === "round";
	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onOpen}
			onKeyDown={(e) => {
				// Keys on the inner play/action buttons bubble here; without this
				// guard, activating one would also open the collection.
				if (e.target !== e.currentTarget) return;
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen();
				}
			}}
			className="group relative flex cursor-pointer flex-col gap-2 rounded-xl p-3 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
		>
			<div className="relative">
				{artwork}
				{onPlay && (
					<Button
						size="icon"
						className={cn(
							"absolute h-9 w-9 rounded-full shadow-md transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
							round ? "bottom-1 right-1" : "bottom-2 right-2",
							playing ? "opacity-100" : "opacity-0",
						)}
						aria-label={playLabel}
						onClick={(e) => {
							e.stopPropagation();
							onPlay();
						}}
					>
						{playing ? (
							<Pause className="h-4 w-4 fill-current" />
						) : (
							<Play className="h-4 w-4 fill-current" />
						)}
					</Button>
				)}
			</div>
			<div className={cn("min-w-0", round && "text-center")}>
				<p
					className={cn(
						"truncate text-sm font-medium transition-colors",
						ownsQueue && "text-primary",
					)}
				>
					{name}
				</p>
				<p className="truncate text-xs text-muted-foreground">{meta}</p>
			</div>
			{actions && (
				<div className="absolute right-1 top-1 flex rounded-md bg-background/70 opacity-0 backdrop-blur-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
					{actions}
				</div>
			)}
		</div>
	);
}
