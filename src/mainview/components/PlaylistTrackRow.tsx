import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical, X } from "lucide-react";
import { TrackArtistItems, TrackEditItem } from "@/components/TrackMenuItems";
import { TrackRow } from "@/components/TrackRow";
import {
	ContextMenuItem,
	ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { RemoteArtist } from "../../shared/rpcSchema";
import type { Track } from "@/player/types";

/**
 * One row of the open playlist's ordered track list: the shared TrackRow with
 * the membership actions only a playlist has — reordering and removal — and
 * the grip that drags it to a new position.
 *
 * The row owns its `<li>` rather than the list rendering one around it, so the
 * sortable ref lands on a direct child of the `<ul>`: `restrictToParentElement`
 * bounds the drag by the *parent element* of the node it is attached to, and a
 * node nested inside the `<li>` would be pinned to its own row.
 *
 * Memoized for the same reason as the other rows: the detail view re-renders
 * on every player timeupdate, and this keeps those ticks from rebuilding every
 * row (incl. a Radix ContextMenu apiece). All props are referentially stable
 * across ticks except the booleans on rows entering/leaving the current-track
 * state. `useSortable` opts the row back into re-rendering while a drag is in
 * progress, which is when it has to move.
 */
export const PlaylistTrackRow = memo(function PlaylistTrackRow({
	track,
	rowIndex,
	serverId,
	artistNames,
	artists,
	isCurrent,
	showBars,
	canMoveUp,
	canMoveDown,
	onPlay,
	onEdit,
	onMove,
	onRemove,
	onOpenArtist,
}: {
	track: Track;
	rowIndex: number;
	/** Server-side track id — membership edits are addressed by it. */
	serverId: string;
	/** The track's linked artist names, for the "Go to artist" entry. */
	artistNames: readonly string[] | undefined;
	artists: RemoteArtist[];
	isCurrent: boolean;
	showBars: boolean;
	canMoveUp: boolean;
	canMoveDown: boolean;
	onPlay: (rowIndex: number) => void;
	onEdit: (track: Track) => void;
	onMove: (serverId: string, direction: -1 | 1) => void;
	onRemove: (serverId: string) => void;
	onOpenArtist: (artistId: number) => void;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: serverId });

	return (
		<li
			ref={setNodeRef}
			style={{
				// Translate only: the rows are uniform, and letting dnd-kit's
				// scale terms through would stretch the one being dragged.
				transform: CSS.Translate.toString(transform),
				transition,
			}}
			className={cn(
				"rounded-lg",
				// The dragged row travels over its neighbours, so it needs to
				// stack above them and stop being see-through while it does.
				isDragging && "relative z-10 bg-accent shadow-lg ring-1 ring-border",
			)}
		>
			<TrackRow
				track={track}
				position={rowIndex + 1}
				isCurrent={isCurrent}
				showBars={showBars}
				onPlay={() => onPlay(rowIndex)}
				menuClassName="w-52"
				dragHandle={
					<button
						ref={setActivatorNodeRef}
						type="button"
						aria-label={`Reorder ${track.title}`}
						// touch-none keeps the pointer sensor from losing the drag
						// to the scroll container's own panning. The negative margin
						// eats into the row's gap-3, which is wider than this pair of
						// left-hand columns wants between them.
						className={cn(
							"-mr-1.5 flex h-7 w-5 shrink-0 touch-none cursor-grab items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							isDragging && "cursor-grabbing text-foreground",
						)}
						// The row plays on click; a grip that was pressed but not
						// dragged must not count as one.
						onClick={(e) => e.stopPropagation()}
						{...attributes}
						{...listeners}
					>
						<GripVertical className="h-4 w-4" />
					</button>
				}
				menu={
					<>
						<TrackEditItem onSelect={() => onEdit(track)} />
						<TrackArtistItems
							artistNames={artistNames}
							artists={artists}
							onOpenArtist={onOpenArtist}
						/>
						<ContextMenuSeparator />
						<ContextMenuItem
							disabled={!canMoveUp}
							onSelect={() => onMove(serverId, -1)}
						>
							<ArrowUp className="h-4 w-4" />
							Move up
						</ContextMenuItem>
						<ContextMenuItem
							disabled={!canMoveDown}
							onSelect={() => onMove(serverId, 1)}
						>
							<ArrowDown className="h-4 w-4" />
							Move down
						</ContextMenuItem>
						<ContextMenuSeparator />
						<ContextMenuItem
							className="text-destructive focus:text-destructive"
							onSelect={() => onRemove(serverId)}
						>
							<X className="h-4 w-4" />
							Remove from playlist
						</ContextMenuItem>
					</>
				}
			/>
		</li>
	);
});
