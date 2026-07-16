import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ImagePlus, Loader2, Music } from "lucide-react";
import {
	libraryService,
	type EditTrackChanges,
} from "@/api/LibraryService";
import { ArtistMultiSelect } from "@/components/ArtistMultiSelect";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useArtists } from "@/hooks/useArtists";
import { blobToBase64 } from "@/lib/utils";
import type { Track } from "@/player/types";

/**
 * Cover editing is three-state: leave it untouched, replace it with a picked
 * file, or remove the existing one. The distinction matters on the wire —
 * `removed` sends `cover: null`, `unchanged` omits the field entirely.
 */
type CoverEdit =
	| { kind: "unchanged" }
	| { kind: "new"; file: File }
	| { kind: "removed" };

/**
 * Edit a server track's title, cover image, and linked artists. Only dirty
 * fields are sent; an unchanged save just closes without a request. Supersedes
 * the old artists-only dialog.
 */
export function EditTrackDialog({
	track,
	open,
	onOpenChange,
}: {
	track: Track | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { artists: artistState } = useArtists();
	const [title, setTitle] = useState("");
	const [cover, setCover] = useState<CoverEdit>({ kind: "unchanged" });
	const [selected, setSelected] = useState<Set<number>>(new Set());
	const [initialIds, setInitialIds] = useState<Set<number>>(new Set());
	const [preview, setPreview] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// The names currently linked to this track, per the last library fetch.
	const currentNames = useMemo(() => {
		if (!track) return new Set<string>();
		return new Set(libraryService.getRemote(track.id)?.artists ?? []);
	}, [track]);

	// Seed a fresh form from the track every time the dialog opens.
	useEffect(() => {
		if (!open) return;
		setTitle(track?.title ?? "");
		setCover({ kind: "unchanged" });
		const initial = new Set<number>();
		for (const artist of artistState.artists) {
			if (currentNames.has(artist.name)) initial.add(artist.id);
		}
		setSelected(new Set(initial));
		setInitialIds(initial);
		setSubmitting(false);
		setError(null);
		// artistState.artists is intentionally omitted: reseeding on a background
		// refresh would discard the user's in-progress edits.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, track]);

	// Preview follows the cover edit: a picked file gets an object URL (revoked
	// on change/unmount), removal shows the fallback, unchanged shows the server
	// cover.
	useEffect(() => {
		if (cover.kind === "new") {
			const url = URL.createObjectURL(cover.file);
			setPreview(url);
			return () => URL.revokeObjectURL(url);
		}
		setPreview(cover.kind === "removed" ? null : (track?.coverUrl ?? null));
	}, [cover, track]);

	const toggle = (id: number) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const removeCover = () => {
		// Removing a track that has no server cover is a no-op edit — revert to
		// unchanged rather than sending a pointless `cover: null`.
		setCover(track?.coverUrl ? { kind: "removed" } : { kind: "unchanged" });
	};

	const sameSet = (a: Set<number>, b: Set<number>) =>
		a.size === b.size && [...a].every((id) => b.has(id));

	const handleSave = async () => {
		if (!track) return;
		const trimmed = title.trim();
		const changes: EditTrackChanges = {};
		if (trimmed !== track.title) changes.title = trimmed;
		if (!sameSet(selected, initialIds)) changes.artistIds = [...selected];
		if (cover.kind === "removed") changes.coverBase64 = null;
		else if (cover.kind === "new") {
			try {
				changes.coverBase64 = await blobToBase64(cover.file);
			} catch {
				setError("Could not read the selected image.");
				return;
			}
		}

		// Nothing dirty → just close, no request.
		if (Object.keys(changes).length === 0) {
			onOpenChange(false);
			return;
		}

		setSubmitting(true);
		setError(null);
		const result = await libraryService.editTrack(track.id, changes);
		setSubmitting(false);
		if (result.ok) onOpenChange(false);
		else setError(result.error);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Edit track</DialogTitle>
					<DialogDescription className="truncate">
						{track ? `Editing “${track.title}”` : ""}
					</DialogDescription>
				</DialogHeader>

				<div className="flex gap-4">
					<div className="flex shrink-0 flex-col items-center gap-1.5">
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							disabled={submitting}
							className="group relative h-28 w-28 shrink-0 overflow-hidden rounded-md bg-muted disabled:opacity-50"
							aria-label="Choose cover image"
						>
							{preview ? (
								<img
									src={preview}
									alt=""
									className="h-full w-full object-cover"
								/>
							) : (
								<Music className="absolute inset-0 m-auto h-9 w-9 text-muted-foreground" />
							)}
							<span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
								<ImagePlus className="h-6 w-6 text-white" />
							</span>
						</button>
						{preview && (
							<button
								type="button"
								onClick={removeCover}
								disabled={submitting}
								className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
							>
								Remove
							</button>
						)}
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (file) setCover({ kind: "new", file });
								// Reset so re-picking the same file fires onChange again.
								e.target.value = "";
							}}
						/>
					</div>

					<div className="flex min-w-0 flex-1 flex-col gap-1.5">
						<label
							htmlFor="edit-title"
							className="text-sm font-medium leading-none"
						>
							Title
						</label>
						<Input
							id="edit-title"
							autoFocus
							value={title}
							onFocus={(e) => e.target.select()}
							onChange={(e) => setTitle(e.target.value)}
							disabled={submitting}
						/>
					</div>
				</div>

				<div className="flex flex-col gap-1.5">
					<span className="text-sm font-medium leading-none">Artists</span>
					<ArtistMultiSelect
						artists={artistState.artists}
						selected={selected}
						onToggle={toggle}
						disabled={submitting}
						className="max-h-48"
					/>
					<span className="text-xs text-muted-foreground">
						{selected.size} selected
					</span>
				</div>

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
						disabled={submitting || title.trim() === ""}
					>
						{submitting && <Loader2 className="h-4 w-4 animate-spin" />}
						{submitting ? "Saving…" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
