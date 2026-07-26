import { memo } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { TrackArtistItems, TrackEditItem } from "@/components/TrackMenuItems";
import { TrackRow } from "@/components/TrackRow";
import {
	ContextMenuItem,
	ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { RemoteArtist } from "../../shared/rpcSchema";
import type { Track } from "@/player/types";

/**
 * One row of the open playlist's ordered track list: the shared TrackRow with
 * the membership actions only a playlist has — reordering and removal.
 *
 * Memoized for the same reason as the other rows: the detail view re-renders
 * on every player timeupdate, and this keeps those ticks from rebuilding every
 * row (incl. a Radix ContextMenu apiece). All props are referentially stable
 * across ticks except the booleans on rows entering/leaving the current-track
 * state.
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
	serverId: number;
	/** The track's linked artist names, for the "Go to artist" entry. */
	artistNames: readonly string[] | undefined;
	artists: RemoteArtist[];
	isCurrent: boolean;
	showBars: boolean;
	canMoveUp: boolean;
	canMoveDown: boolean;
	onPlay: (rowIndex: number) => void;
	onEdit: (track: Track) => void;
	onMove: (serverId: number, direction: -1 | 1) => void;
	onRemove: (serverId: number) => void;
	onOpenArtist: (artistId: number) => void;
}) {
	return (
		<TrackRow
			track={track}
			position={rowIndex + 1}
			isCurrent={isCurrent}
			showBars={showBars}
			onPlay={() => onPlay(rowIndex)}
			menuClassName="w-52"
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
	);
});
