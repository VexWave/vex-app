import type { Track } from "@/player/types";
import { bun } from "./rpc";
import { sessionService } from "./SessionService";

export interface UploadEntry {
	status: "uploading" | "done" | "error";
	error?: string;
}

/** Immutable per-track upload status by track id. */
export type UploadSnapshot = Readonly<Record<string, UploadEntry>>;

/**
 * Fire-and-forget upload queue. Tracks are read back from their blob URLs,
 * base64-encoded and sent to the bun process, which gzips and POSTs them.
 * Uploads run sequentially (one in flight) to bound memory usage; local
 * playback is never affected by upload failures.
 */
export class UploadService {
	private subscribers = new Set<() => void>();
	private statuses = new Map<string, UploadEntry>();
	private snapshot: UploadSnapshot = {};
	private queue: Track[] = [];
	private working = false;

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): UploadSnapshot => this.snapshot;

	enqueue(tracks: Track[]): void {
		if (tracks.length === 0) return;
		for (const track of tracks) {
			this.statuses.set(track.id, { status: "uploading" });
			this.queue.push(track);
		}
		this.refresh();
		void this.work();
	}

	private async work(): Promise<void> {
		if (this.working) return;
		this.working = true;
		try {
			let track: Track | undefined;
			while ((track = this.queue.shift())) {
				await this.upload(track);
			}
		} finally {
			this.working = false;
		}
	}

	private async upload(track: Track): Promise<void> {
		try {
			// The blob URL keeps the bytes alive even if the queue entry is
			// removed mid-upload.
			const blob = await (await fetch(track.src)).blob();
			const result = await bun.uploadTrack({
				title: track.title,
				durationSec: track.durationSec,
				dataBase64: await blobToBase64(blob),
			});
			if (result.ok) {
				this.statuses.set(track.id, { status: "done" });
			} else {
				this.statuses.set(track.id, { status: "error", error: result.error });
				if (result.status === 401) {
					sessionService.markExpired(
						"Session expired — please log in again.",
					);
				}
			}
		} catch (err) {
			this.statuses.set(track.id, {
				status: "error",
				error: err instanceof Error ? err.message : "Upload failed",
			});
		}
		this.refresh();
	}

	private refresh(): void {
		this.snapshot = Object.fromEntries(this.statuses);
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
