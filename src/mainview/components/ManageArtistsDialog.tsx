import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Loader2, Users } from "lucide-react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { useArtists } from "@/hooks/useArtists";
import { cn } from "@/lib/utils";
import type { Track } from "@/player/types";

/**
 * Add/remove the artists linked to a server track. The server keys links by
 * artist id, so the current links are matched from the track's artist names
 * against the known artist list; saving replaces the links wholesale.
 */
export function ManageArtistsDialog({
	track,
	open,
	onOpenChange,
}: {
	track: Track | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { artists: artistState } = useArtists();
	const [selected, setSelected] = useState<Set<number>>(new Set());
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// The names currently linked to this track, per the last library fetch.
	const currentNames = useMemo(() => {
		if (!track) return new Set<string>();
		return new Set(libraryService.getRemote(track.id)?.artists ?? []);
	}, [track]);

	// Seed the selection from the current links every time the dialog opens.
	useEffect(() => {
		if (!open) return;
		const initial = new Set<number>();
		for (const artist of artistState.artists) {
			if (currentNames.has(artist.name)) initial.add(artist.id);
		}
		setSelected(initial);
		setSubmitting(false);
		setError(null);
		// artistState.artists is intentionally omitted: reseeding on a background
		// refresh would discard the user's in-progress edits.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, track]);

	const toggle = (id: number) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const handleSave = async () => {
		if (!track) return;
		setSubmitting(true);
		setError(null);
		const result = await libraryService.setArtists(track.id, [...selected]);
		setSubmitting(false);
		if (result.ok) onOpenChange(false);
		else setError(result.error);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Artists</DialogTitle>
					<DialogDescription className="truncate">
						{track ? `Linked to “${track.title}”` : ""}
					</DialogDescription>
				</DialogHeader>

				{artistState.artists.length === 0 ? (
					<div className="flex flex-col items-center gap-2 py-6 text-center text-muted-foreground">
						<Users className="h-8 w-8" />
						<p className="text-sm">
							No artists yet — create some in the Artists tab first.
						</p>
					</div>
				) : (
					<ScrollArea className="max-h-64">
						<ul className="flex flex-col gap-1 pr-3">
							{artistState.artists.map((artist) => {
								const checked = selected.has(artist.id);
								return (
									<li key={artist.id}>
										<button
											type="button"
											disabled={submitting}
											onClick={() => toggle(artist.id)}
											className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
										>
											<span
												className={cn(
													"flex h-4 w-4 shrink-0 items-center justify-center rounded border",
													checked
														? "border-primary bg-primary text-primary-foreground"
														: "border-input",
												)}
											>
												{checked && <Check className="h-3 w-3" />}
											</span>
											<span className="truncate">{artist.name}</span>
										</button>
									</li>
								);
							})}
						</ul>
					</ScrollArea>
				)}

				{error && (
					<div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
						<AlertCircle className="h-4 w-4 shrink-0" />
						<span>{error}</span>
					</div>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={submitting}
					>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={() => void handleSave()}
						disabled={submitting || artistState.artists.length === 0}
					>
						{submitting && <Loader2 className="h-4 w-4 animate-spin" />}
						{submitting ? "Saving…" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
