import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, ImagePlus, ListMusic, Loader2 } from "lucide-react";
import { playlistService } from "@/api/PlaylistService";
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
import { blobToBase64 } from "@/lib/utils";
import type { RemotePlaylist } from "../../shared/rpcSchema";

/**
 * Cover editing is three-state, same as ArtistDialog's avatar: leave the
 * existing image untouched, replace it with a picked file, or remove it.
 * `removed` sends `image: null`; `unchanged` omits the field entirely. In
 * create mode there is nothing to remove, so only `unchanged` and `new` occur.
 */
type ImageEdit =
	| { kind: "unchanged" }
	| { kind: "new"; file: File }
	| { kind: "removed" };

/**
 * Create a new playlist or edit an existing one (`playlist === null` →
 * create). Name is required; the cover is uploaded as raw image bytes.
 * `seedTrackIds` pre-fills a created playlist's track list (the library
 * context menu's "New playlist…" passes the right-clicked track).
 */
export function PlaylistDialog({
	playlist,
	seedTrackIds,
	open,
	onOpenChange,
}: {
	playlist: RemotePlaylist | null;
	seedTrackIds?: number[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const isEdit = playlist !== null;
	const [name, setName] = useState("");
	const [image, setImage] = useState<ImageEdit>({ kind: "unchanged" });
	const [preview, setPreview] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Fresh form seeded from the playlist (if any) every time the dialog opens.
	useEffect(() => {
		if (!open) return;
		setName(playlist?.name ?? "");
		setImage({ kind: "unchanged" });
		setSubmitting(false);
		setError(null);
	}, [open, playlist]);

	// Preview follows the image edit: a picked file gets an object URL (revoked
	// on change/unmount), removal shows the fallback, unchanged shows the
	// current cover (if any).
	useEffect(() => {
		if (image.kind === "new") {
			const url = URL.createObjectURL(image.file);
			setPreview(url);
			return () => URL.revokeObjectURL(url);
		}
		setPreview(image.kind === "removed" ? null : (playlist?.imageUrl ?? null));
	}, [image, playlist]);

	const removeImage = () => {
		// Removing a playlist that has no cover is a no-op edit — revert to
		// unchanged rather than sending a pointless `image: null`.
		setImage(playlist?.imageUrl ? { kind: "removed" } : { kind: "unchanged" });
	};

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		const trimmedName = name.trim();
		if (!trimmedName) {
			setError("Name is required.");
			return;
		}
		setError(null);
		setSubmitting(true);

		// undefined = unchanged/no cover; null = remove; string = new bytes.
		let imageBase64: string | null | undefined;
		if (image.kind === "new") {
			try {
				imageBase64 = await blobToBase64(image.file);
			} catch {
				setSubmitting(false);
				setError("Could not read the selected image.");
				return;
			}
		} else if (image.kind === "removed") {
			imageBase64 = null;
		}

		const result = isEdit
			? await playlistService.edit({
					id: playlist.id,
					name: trimmedName,
					imageBase64,
				})
			: await playlistService.create({
					name: trimmedName,
					trackIds: seedTrackIds,
					// create has no null state; only a picked file produces bytes.
					imageBase64: imageBase64 ?? undefined,
				});
		setSubmitting(false);
		if (result.ok) {
			onOpenChange(false);
		} else {
			setError(result.error);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit playlist" : "New playlist"}</DialogTitle>
					<DialogDescription>
						{isEdit
							? "Update the playlist's name or cover."
							: seedTrackIds?.length
								? "The playlist is created on the server, starting with the selected track."
								: "The playlist is created on the server; add tracks from the library."}
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => void handleSubmit(e)}
				>
					<div className="flex items-center gap-4">
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							disabled={submitting}
							className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted disabled:opacity-50"
							aria-label="Choose cover image"
						>
							{preview ? (
								<img
									src={preview}
									alt=""
									className="h-full w-full object-cover"
								/>
							) : (
								<ListMusic className="absolute inset-0 m-auto h-6 w-6 text-muted-foreground" />
							)}
							<span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
								<ImagePlus className="h-5 w-5 text-white" />
							</span>
						</button>
						<div className="flex flex-col gap-1.5">
							<span className="text-sm font-medium leading-none">
								Cover <span className="text-muted-foreground">(optional)</span>
							</span>
							<span className="text-xs text-muted-foreground">
								{image.kind === "new"
									? image.file.name
									: image.kind === "removed"
										? "Cover will be removed."
										: isEdit
											? "Pick a new image to replace it."
											: "Click the square to choose an image."}
							</span>
							{preview && (
								<button
									type="button"
									onClick={removeImage}
									disabled={submitting}
									className="self-start text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
								>
									Remove
								</button>
							)}
						</div>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (file) setImage({ kind: "new", file });
								// Reset so re-picking the same file fires onChange again.
								e.target.value = "";
							}}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<label
							htmlFor="playlist-name"
							className="text-sm font-medium leading-none"
						>
							Name
						</label>
						<Input
							id="playlist-name"
							autoFocus
							value={name}
							onChange={(e) => setName(e.target.value)}
							disabled={submitting}
						/>
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
						<Button type="submit" disabled={submitting}>
							{submitting && <Loader2 className="h-4 w-4 animate-spin" />}
							{submitting
								? isEdit
									? "Saving…"
									: "Creating…"
								: isEdit
									? "Save"
									: "Create"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
