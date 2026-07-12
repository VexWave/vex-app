import { useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { uploadService } from "@/api/UploadService";
import { Button } from "@/components/ui/button";
import { usePlayer } from "@/hooks/usePlayer";
import { LocalTrackLoader } from "@/player/LocalTrackLoader";

const loader = new LocalTrackLoader();

export function AddTracksButton() {
	const { controller } = usePlayer();
	const inputRef = useRef<HTMLInputElement>(null);
	const [loading, setLoading] = useState(false);

	const handleFiles = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setLoading(true);
		try {
			const tracks = await loader.loadFiles(files);
			controller.addTracks(tracks);
			uploadService.enqueue(tracks);
		} finally {
			setLoading(false);
		}
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
					void handleFiles(e.target.files);
					e.target.value = "";
				}}
			/>
			<Button
				variant="secondary"
				disabled={loading}
				onClick={() => inputRef.current?.click()}
			>
				{loading ? (
					<Loader2 className="h-4 w-4 animate-spin" />
				) : (
					<Plus className="h-4 w-4" />
				)}
				Add songs
			</Button>
		</>
	);
}
