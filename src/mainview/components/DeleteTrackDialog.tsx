import { libraryService } from "@/api/LibraryService";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { Track } from "@/player/types";

/** Confirmation before permanently deleting a track from the server. */
export function DeleteTrackDialog({
	track,
	open,
	onOpenChange,
}: {
	track: Track | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Delete track?</DialogTitle>
					<DialogDescription>
						Permanently deletes “{track?.title}” from the server.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={() => {
							if (track) void libraryService.removeTrack(track.id);
							onOpenChange(false);
						}}
					>
						Delete
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
