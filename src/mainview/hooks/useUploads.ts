import { useSyncExternalStore } from "react";
import { uploadService } from "@/api/UploadService";
import type { UploadSnapshot } from "@/api/UploadService";

export function useUploads(): UploadSnapshot {
	return useSyncExternalStore(
		uploadService.subscribe,
		uploadService.getSnapshot,
	);
}
