import { storage } from "@/lib/storage";
import type { Track } from "@/player/types";
import { bun } from "./rpc";

export interface DownloadState {
	/** Track ids with a write in flight — what the menu entry reads. */
	activeIds: readonly string[];
	/** Where the last finished download landed, until `NOTICE_MS` is up. */
	done: { trackId: string; path: string } | null;
	/**
	 * The download that failed, named by the track it was for: downloads run
	 * side by side, and one that succeeds may only clear the message if it is
	 * the same track's second try. Otherwise a second download quietly takes a
	 * failure off the screen before it was read.
	 */
	error: { trackId: string; message: string } | null;
}

const NOTICE_MS = 6000;

/**
 * Keeping a copy of a track on the machine. What the file ends up called is
 * bun's to decide, so all this holds is which downloads are running, where the
 * last one landed, and whether it failed. The folder the user picked is
 * persisted, so the next picker opens there.
 */
export class DownloadService {
	private subscribers = new Set<() => void>();
	private snapshot: DownloadState = { activeIds: [], error: null, done: null };

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): DownloadState => this.snapshot;

	/**
	 * Writes the track to the user's Downloads folder. One download per track
	 * at a time, so a second click on an entry that is still working doesn't
	 * land a duplicate copy beside the first.
	 */
	download = async (track: Track): Promise<void> => {
		if (this.snapshot.activeIds.includes(track.id)) return;
		this.update({ activeIds: [...this.snapshot.activeIds, track.id] });
		let message: string | null = null;
		let done: DownloadState["done"] = null;
		try {
			const result = await bun.downloadTrack({
				id: track.id,
				fileName: track.artist
					? `${track.artist} - ${track.title}`
					: track.title,
				startingFolder: storage.downloads.folder.get() ?? undefined,
			});
			if (!result.ok) message = result.error;
			else if (result.path) {
				done = { trackId: track.id, path: result.path };
				if (result.folder) storage.downloads.folder.set(result.folder);
			}
		} catch (err) {
			message = err instanceof Error ? err.message : "The download failed.";
		}
		const standing = this.snapshot.error;
		this.update({
			activeIds: this.snapshot.activeIds.filter((id) => id !== track.id),
			error: message
				? { trackId: track.id, message }
				: standing?.trackId === track.id
					? null
					: standing,
			done: done ?? this.snapshot.done,
		});
		if (done) {
			// Only the timer whose notice is still up may take one down.
			const shown = done;
			setTimeout(() => {
				if (this.snapshot.done === shown) this.update({ done: null });
			}, NOTICE_MS);
		}
	};

	private update(patch: Partial<DownloadState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — a download outlives the menu it was started from. */
export const downloadService = new DownloadService();
