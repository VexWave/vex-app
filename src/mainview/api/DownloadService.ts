import type { Track } from "@/player/types";
import { bun } from "./rpc";

export interface DownloadState {
	/** Track ids with a write in flight — what the menu entry reads. */
	activeIds: readonly string[];
	/**
	 * The download that failed, named by the track it was for: downloads run
	 * side by side, and one that succeeds may only clear the message if it is
	 * the same track's second try. Otherwise a second download quietly takes a
	 * failure off the screen before it was read.
	 */
	error: { trackId: string; message: string } | null;
}

/**
 * Keeping a copy of a track on the machine. Where the file goes and what it
 * ends up called is bun's to decide — the webview knows neither the user's
 * folders nor what container the bytes are in — so all this holds is which
 * downloads are running and whether the last one failed.
 */
export class DownloadService {
	private subscribers = new Set<() => void>();
	private snapshot: DownloadState = { activeIds: [], error: null };

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
		try {
			const result = await bun.downloadTrack({
				id: track.id,
				fileName: track.artist
					? `${track.artist} - ${track.title}`
					: track.title,
			});
			if (!result.ok) message = result.error;
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
		});
	};

	private update(patch: Partial<DownloadState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — a download outlives the menu it was started from. */
export const downloadService = new DownloadService();
