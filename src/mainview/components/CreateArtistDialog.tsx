import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
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

export function CreateArtistDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [name, setName] = useState("");
	const [imageUrl, setImageUrl] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Fresh form every time the dialog opens.
	useEffect(() => {
		if (open) {
			setName("");
			setImageUrl("");
			setSubmitting(false);
			setError(null);
		}
	}, [open]);

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		const trimmedName = name.trim();
		if (!trimmedName) {
			setError("Name is required.");
			return;
		}
		setError(null);
		setSubmitting(true);
		const result = await artistService.create({
			name: trimmedName,
			imageUrl: imageUrl.trim() || undefined,
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
					<DialogTitle>New artist</DialogTitle>
					<DialogDescription>
						The artist is created on the server and can be linked to tracks.
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => void handleSubmit(e)}
				>
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
					<div className="flex flex-col gap-1.5">
						<label
							htmlFor="artist-image-url"
							className="text-sm font-medium leading-none"
						>
							Image URL <span className="text-muted-foreground">(optional)</span>
						</label>
						<Input
							id="artist-image-url"
							placeholder="https://…"
							value={imageUrl}
							onChange={(e) => setImageUrl(e.target.value)}
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
							{submitting ? "Creating…" : "Create"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
