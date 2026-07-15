import { parseBlob } from "music-metadata";
import { bun } from "./rpc";
import { libraryService } from "./LibraryService";
import { sessionService } from "./SessionService";

export interface UploadItem {
	/** Client-side id for this pending upload — not the server track id. */
	id: string;
	/** Display title: the file name until metadata is parsed, then its tag. */
	title: string;
	status: "uploading" | "error";
	error?: string;
}

/** Immutable, ordered list of in-flight/failed uploads. */
export type UploadSnapshot = readonly UploadItem[];

interface QueueEntry {
	item: UploadItem;
	file: File;
}

/**
 * Upload queue for picked/dropped audio files. Each file is read, its
 * title/duration tags parsed, gzipped and POSTed by the bun process. Uploads
 * run sequentially (one in flight) to bound memory use. There is no local
 * playback: a successful upload triggers a library refresh, so the track
 * re-enters the queue as a server track that streams through the bun proxy.
 * Failures stay in the snapshot so the list can surface them.
 */
export class UploadService {
	private subscribers = new Set<() => void>();
	private items: UploadItem[] = [];
	private snapshot: UploadSnapshot = [];
	private queue: QueueEntry[] = [];
	private working = false;

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): UploadSnapshot => this.snapshot;

	enqueue(files: Iterable<File>): void {
		const audioFiles = [...files].filter(
			(file) => file.type.startsWith("audio/") || file.type === "video/mp4",
		);
		if (audioFiles.length === 0) return;
		for (const file of audioFiles) {
			const item: UploadItem = {
				id: crypto.randomUUID(),
				title: file.name.replace(/\.[^.]+$/, ""),
				status: "uploading",
			};
			this.items.push(item);
			this.queue.push({ item, file });
		}
		this.refresh();
		void this.work();
	}

	private async work(): Promise<void> {
		if (this.working) return;
		this.working = true;
		try {
			let entry: QueueEntry | undefined;
			while ((entry = this.queue.shift())) {
				await this.upload(entry);
			}
		} finally {
			this.working = false;
		}
	}

	private async upload({ item, file }: QueueEntry): Promise<void> {
		try {
			// Tags are best-effort: an unreadable/absent title keeps the file
			// name, and a missing duration lets the server/player fill it in.
			const metadata = await parseBlob(file).catch(() => null);
			if (metadata?.common.title) item.title = metadata.common.title;
			this.refresh();
			const result = await bun.uploadTrack({
				title: item.title,
				durationSec: metadata?.format.duration ?? 0,
				dataBase64: await blobToBase64(file),
			});
			if (result.ok) {
				// The track only leaves the pending list once the library refresh
				// has actually put it back in the queue as a streaming track —
				// dropping the placeholder first would make an uploaded track
				// vanish from the UI if that refresh failed.
				if (await libraryService.refresh()) {
					this.items = this.items.filter((i) => i !== item);
				} else {
					item.status = "error";
					item.error = "Uploaded, but refreshing the library failed.";
				}
			} else {
				item.status = "error";
				item.error = result.error;
				if (result.status === 401) {
					sessionService.markExpired(
						"Session expired — please log in again.",
					);
				}
			}
		} catch (err) {
			item.status = "error";
			item.error = err instanceof Error ? err.message : "Upload failed";
		}
		this.refresh();
	}

	private refresh(): void {
		this.snapshot = [...this.items];
		this.subscribers.forEach((notify) => notify());
	}
}

/** FileReader avoids chunked btoa gymnastics for multi-MB blobs. */
function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () =>
			reject(reader.error ?? new Error("Failed to read audio data"));
		reader.onload = () => {
			const dataUrl = reader.result as string;
			resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
		};
		reader.readAsDataURL(blob);
	});
}

/** App-wide singleton — uploads must survive component unmounts. */
export const uploadService = new UploadService();
