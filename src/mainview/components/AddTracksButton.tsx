import { useRef } from "react";
import { Plus } from "lucide-react";
import { uploadService } from "@/api/UploadService";
import { Button } from "@/components/ui/button";

export function AddTracksButton() {
	const inputRef = useRef<HTMLInputElement>(null);

	// Picked files are uploaded to the server; they appear in the queue as
	// streaming tracks once the upload completes.
	const handleFiles = (files: FileList | null) => {
		if (!files || files.length === 0) return;
		uploadService.enqueue(files);
	};

	return (
		<>
			<input
				ref={inputRef}
				type="file"
				accept="audio/*"
				multiple
				className="hidden"
				onChange={(e) => {
					handleFiles(e.target.files);
					e.target.value = "";
				}}
			/>
			<Button
				variant="secondary"
				onClick={() => inputRef.current?.click()}
			>
				<Plus className="h-4 w-4" />
				Add songs
			</Button>
		</>
	);
}
