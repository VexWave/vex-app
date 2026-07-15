import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, ImagePlus, Loader2, Users } from "lucide-react";
import { artistService } from "@/api/ArtistService";
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
import type { RemoteArtist } from "../../shared/rpcSchema";

/**
 * Create a new artist or edit an existing one (`artist === null` → create).
 * The avatar is uploaded as raw image bytes; in edit mode the current avatar
 * shows as a preview and is only replaced when a new file is picked (the
 * contract has no way to clear an avatar).
 */
export function ArtistDialog({
	artist,
	open,
	onOpenChange,
}: {
	artist: RemoteArtist | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const isEdit = artist !== null;
	const [name, setName] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [preview, setPreview] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Fresh form seeded from the artist (if any) every time the dialog opens.
	useEffect(() => {
		if (!open) return;
		setName(artist?.name ?? "");
		setFile(null);
		setPreview(artist?.imageUrl ?? null);
		setSubmitting(false);
		setError(null);
	}, [open, artist]);

	// Show a local preview of a freshly picked file; revoke the object URL when
	// it's replaced or the dialog closes.
	useEffect(() => {
		if (!file) return;
		const url = URL.createObjectURL(file);
		setPreview(url);
		return () => URL.revokeObjectURL(url);
	}, [file]);

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		const trimmedName = name.trim();
		if (!trimmedName) {
			setError("Name is required.");
			return;
		}
		setError(null);
		setSubmitting(true);

		let imageBase64: string | undefined;
		if (file) {
			try {
				imageBase64 = await blobToBase64(file);
			} catch {
				setSubmitting(false);
				setError("Could not read the selected image.");
				return;
			}
		}

		const result = isEdit
			? await artistService.edit({ id: artist.id, name: trimmedName, imageBase64 })
			: await artistService.create({ name: trimmedName, imageBase64 });
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
					<DialogTitle>{isEdit ? "Edit artist" : "New artist"}</DialogTitle>
					<DialogDescription>
						{isEdit
							? "Update the artist's name or avatar."
							: "The artist is created on the server and can be linked to tracks."}
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
							className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-full bg-muted disabled:opacity-50"
							aria-label="Choose avatar image"
						>
							{preview ? (
								<img
									src={preview}
									alt=""
									className="h-full w-full object-cover"
								/>
							) : (
								<Users className="absolute inset-0 m-auto h-6 w-6 text-muted-foreground" />
							)}
							<span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
								<ImagePlus className="h-5 w-5 text-white" />
							</span>
						</button>
						<div className="flex flex-col gap-1.5">
							<span className="text-sm font-medium leading-none">
								Avatar{" "}
								<span className="text-muted-foreground">(optional)</span>
							</span>
							<span className="text-xs text-muted-foreground">
								{file
									? file.name
									: isEdit
										? "Pick a new image to replace it."
										: "Click the circle to choose an image."}
							</span>
						</div>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							className="hidden"
							onChange={(e) => setFile(e.target.files?.[0] ?? null)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<label
							htmlFor="artist-name"
							className="text-sm font-medium leading-none"
						>
							Name
						</label>
						<Input
							id="artist-name"
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
