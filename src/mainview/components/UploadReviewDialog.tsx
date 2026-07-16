import {
	useEffect,
	useRef,
	useState,
	type FormEvent,
} from "react";
import { AlertCircle, ImagePlus, Music } from "lucide-react";
import { artistService } from "@/api/ArtistService";
import { uploadService, type StagedUpload } from "@/api/UploadService";
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
import { useUploads } from "@/hooks/useUploads";
import type { RemoteArtist } from "../../shared/rpcSchema";

/**
 * Per-file review step shown before uploading picked/dropped audio. One dialog
 * item at a time (the head of the staged queue); confirming or skipping advances
 * to the next. The dialog stays mounted across items — only the inner form
 * remounts (keyed by file id) — so there's no close/reopen flicker in a batch.
 * Esc/X cancels the whole remaining batch; an outside click is ignored so a
 * stray click can't discard it.
 */
export function UploadReviewDialog() {
	const { staged, reviewedCount } = useUploads();
	const { artists: artistState } = useArtists();
	const head = staged[0];
	const hasBatch = head !== undefined;

	// Refresh the artist list once when a batch opens, so artists created just
	// before picking files show up in the multi-select.
	const prevHasBatch = useRef(false);
	useEffect(() => {
		if (hasBatch && !prevHasBatch.current) void artistService.refresh();
		prevHasBatch.current = hasBatch;
	}, [hasBatch]);

	return (
		<Dialog
			open={hasBatch}
			onOpenChange={(open) => {
				if (!open) uploadService.cancelAll();
			}}
		>
			<DialogContent
				className="max-w-lg"
				onInteractOutside={(e) => e.preventDefault()}
			>
				{head && (
					<ReviewForm
						key={head.id}
						item={head}
						position={reviewedCount + 1}
						total={reviewedCount + staged.length}
						remaining={staged.length}
						artists={artistState.artists}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function ReviewForm({
	item,
	position,
	total,
	remaining,
	artists,
}: {
	item: StagedUpload;
	position: number;
	total: number;
	remaining: number;
	artists: RemoteArtist[];
}) {
	const [title, setTitle] = useState(item.title);
	const [coverBlob, setCoverBlob] = useState<Blob | null>(item.coverBlob);
	const [selected, setSelected] = useState<Set<number>>(new Set());
	const [preview, setPreview] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Object-URL preview for the current cover (embedded blob or picked file),
	// revoked when the cover changes or the form unmounts.
	useEffect(() => {
		if (!coverBlob) {
			setPreview(null);
			return;
		}
		const url = URL.createObjectURL(coverBlob);
		setPreview(url);
		return () => URL.revokeObjectURL(url);
	}, [coverBlob]);

	const toggle = (id: number) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	/** Validate + confirm the head; returns false (and shows an error) if the
	 * title is empty. */
	const confirmHead = (): boolean => {
		const trimmed = title.trim();
		if (!trimmed) {
			setError("A title is required.");
			return false;
		}
		uploadService.confirm(item.id, {
			title: trimmed,
			artistIds: [...selected],
			coverBlob,
		});
		return true;
	};

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault();
		confirmHead();
	};

	return (
		<form className="flex flex-col gap-4" onSubmit={handleSubmit}>
			<DialogHeader>
				<DialogTitle className="flex items-center gap-2">
					Add to library
					{total > 1 && (
						<span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
							Track {position} of {total}
						</span>
					)}
				</DialogTitle>
				<DialogDescription className="truncate">
					{item.fileName}
				</DialogDescription>
			</DialogHeader>

			<div className="flex gap-4">
				<div className="flex shrink-0 flex-col items-center gap-1.5">
					<button
						type="button"
						onClick={() => fileInputRef.current?.click()}
						className="group relative h-28 w-28 shrink-0 overflow-hidden rounded-md bg-muted"
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
					{coverBlob && (
						<button
							type="button"
							onClick={() => setCoverBlob(null)}
							className="text-xs text-muted-foreground transition-colors hover:text-foreground"
						>
							Remove
						</button>
					)}
					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						className="hidden"
						onChange={(e) => setCoverBlob(e.target.files?.[0] ?? null)}
					/>
				</div>

				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<label
						htmlFor="upload-title"
						className="text-sm font-medium leading-none"
					>
						Title
					</label>
					<Input
						id="upload-title"
						autoFocus
						value={title}
						onFocus={(e) => e.target.select()}
						onChange={(e) => setTitle(e.target.value)}
					/>
				</div>
			</div>

			<div className="flex flex-col gap-1.5">
				<span className="text-sm font-medium leading-none">Artists</span>
				<ArtistMultiSelect
					artists={artists}
					selected={selected}
					onToggle={toggle}
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

			<DialogFooter className="sm:justify-between">
				<div className="flex gap-2">
					<Button
						type="button"
						variant="ghost"
						onClick={() => uploadService.skip(item.id)}
					>
						Skip
					</Button>
					{remaining > 1 && (
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								if (confirmHead()) uploadService.confirmAll();
							}}
						>
							Upload all {remaining}
						</Button>
					)}
				</div>
				<Button type="submit">Upload</Button>
			</DialogFooter>
		</form>
	);
}
