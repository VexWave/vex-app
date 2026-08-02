import { parseBlob } from "music-metadata";
import {
	MAX_AUDIO_BYTES,
	MAX_DURATION_MS,
	MAX_IMAGE_BYTES,
	MAX_NAME_LENGTH,
} from "../../shared/limits";
import type { ImportedArtist } from "../../shared/rpcSchema";
import { blobToBase64, tooLargeMessage } from "@/lib/utils";
import { artistService } from "./ArtistService";
import { bun } from "./rpc";
import { libraryService } from "./LibraryService";
import { sessionService } from "./SessionService";

export interface UploadItem {
	/** Client-side id for this pending upload — not the server track id. */
	id: string;
	/** Display title: the edited title confirmed in the review dialog. */
	title: string;
	status: "uploading" | "error";
	error?: string;
}

/**
 * The artist proposed for a staged upload — currently only produced by URL
 * imports, where yt-dlp resolves the media's creator. The review dialog offers
 * it as a one-click link. Kept in the wire shape (base64, not a Blob) because
 * that is what both consumers want: a `data:` URL for the preview and the raw
 * base64 for `createArtist`.
 */
export type SuggestedArtist = ImportedArtist;

/**
 * A picked/dropped file whose tags have been parsed and that is now awaiting
 * review in the upload dialog. Prefilled from the file's metadata; the user
 * can edit the title and cover before confirming the upload. The last two
 * fields are whatever the caller sent along with the file (`EnqueueOptions`) —
 * only URL imports send anything.
 */
export interface StagedUpload {
	id: string;
	file: File;
	/** For the dialog subtitle. */
	fileName: string;
	/** common.title ?? filename stem. */
	title: string;
	/** Math.round((format.duration ?? 0) * 1000). */
	durationMs: number;
	/** Embedded cover art (common.picture[0]), or null when absent. */
	coverBlob: Blob | null;
	/** Artist proposed by a URL import; null for picked/dropped files. */
	suggestedArtist: SuggestedArtist | null;
	/** Play this track once its upload has landed in the library. */
	playWhenReady: boolean;
}

/** What a file can carry into the review flow beyond the file itself. */
export interface EnqueueOptions {
	/** Artist proposed by a URL import; the review dialog offers it as a link. */
	suggestedArtist?: SuggestedArtist;
	/**
	 * Start the track as soon as the upload has landed. Set by URL imports: a
	 * download the user went and asked for is one they asked to hear.
	 */
	playWhenReady?: boolean;
}

/** Immutable snapshot of the whole upload state, consumed by React. */
export interface UploadState {
	/** In-flight/failed uploads. */
	uploads: readonly UploadItem[];
	/** Files awaiting review, FIFO. */
	staged: readonly StagedUpload[];
	/** Confirmed+skipped in the current batch → drives the "N of M" indicator. */
	reviewedCount: number;
}

interface QueueEntry {
	item: UploadItem;
	file: File;
	durationMs: number;
	coverBlob: Blob | null;
	artistIds: number[];
	playWhenReady: boolean;
}

/** Edits confirmed for a staged file in the review dialog. */
export interface ConfirmEdits {
	title: string;
	artistIds: number[];
	coverBlob: Blob | null;
}

/**
 * Upload queue for picked/dropped audio files. Each file is first parsed and
 * staged for review (cover/title, plus a proposed artist for URL imports), and
 * only uploaded once the user confirms it in the dialog. Confirmed files are
 * POSTed by the bun process; uploads run sequentially (one in flight) to bound
 * memory use. There is no local playback: a successful upload triggers a
 * library refresh, so the track re-enters the queue as a server track that
 * streams through the bun proxy — which is also the earliest a `playWhenReady`
 * file can start (see `playLanded`). Failures stay in the snapshot so the list
 * can surface them.
 */
export class UploadService {
	private subscribers = new Set<() => void>();
	private items: UploadItem[] = [];
	private staged: StagedUpload[] = [];
	private reviewedCount = 0;
	private snapshot: UploadState = { uploads: [], staged: [], reviewedCount: 0 };
	private queue: QueueEntry[] = [];
	private working = false;
	private autoPlayed = false;

	constructor() {
		let previousStatus = sessionService.getSnapshot().status;
		sessionService.subscribe(() => {
			const status = sessionService.getSnapshot().status;
			if (status === previousStatus) return;
			previousStatus = status;
			// Staged files carry session-scoped artist ids and stream URLs, so a
			// half-reviewed batch can't outlive the session that produced it.
			if (status === "loggedOut") this.cancelAll();
		});
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): UploadState => this.snapshot;

	/**
	 * Parse the picked/dropped audio files and stage them for review. Files are
	 * parsed sequentially and appended as each one is ready, so the dialog opens
	 * as soon as the first file has been parsed. Whatever `options` carries is
	 * attached to every file of the call — an import enqueues one at a time.
	 */
	async enqueue(
		files: Iterable<File>,
		options: EnqueueOptions = {},
	): Promise<void> {
		const audioFiles = [...files].filter(
			(file) => file.type.startsWith("audio/") || file.type === "video/mp4",
		);
		if (audioFiles.length === 0) return;
		for (const file of audioFiles) {
			// Refused before it is even read: base64 costs a third more again and
			// the whole string crosses the RPC bridge, so a file the server's
			// ceiling rules out is never encoded. It surfaces as a failed row,
			// the same place every other upload failure lands.
			const tooLarge = tooLargeMessage(file.size, MAX_AUDIO_BYTES, "track");
			if (tooLarge) {
				this.items.push({
					id: crypto.randomUUID(),
					title: file.name,
					status: "error",
					error: tooLarge,
				});
				this.emit();
				continue;
			}
			// Tags are best-effort: an unreadable/absent title falls back to the
			// file name, a missing duration to 0, and no picture to no cover.
			const metadata = await parseBlob(file).catch(() => null);
			const pic = metadata?.common.picture?.[0];
			this.staged.push({
				id: crypto.randomUUID(),
				file,
				fileName: file.name,
				title: clampTitle(
					metadata?.common.title ?? file.name.replace(/\.[^.]+$/, ""),
				),
				durationMs: clampDuration(metadata?.format.duration),
				// Artwork embedded in a tag can be over the image ceiling on its
				// own, and it is the one cover nobody chose — carrying it would
				// fail the whole upload for it. The file is staged without one
				// instead, which the review dialog shows and can replace.
				coverBlob:
					pic && pic.data.byteLength <= MAX_IMAGE_BYTES
						? new Blob([new Uint8Array(pic.data)], { type: pic.format })
						: null,
				suggestedArtist: options.suggestedArtist ?? null,
				playWhenReady: options.playWhenReady ?? false,
			});
			this.emit();
		}
	}

	/** Confirm a staged file's edits and start uploading it. */
	confirm(stagedId: string, edits: ConfirmEdits): void {
		const staged = this.staged.find((s) => s.id === stagedId);
		if (!staged) return;
		this.staged = this.staged.filter((s) => s !== staged);
		this.reviewedCount += 1;
		const item: UploadItem = {
			id: crypto.randomUUID(),
			title: edits.title,
			status: "uploading",
		};
		this.items.push(item);
		this.queue.push({
			item,
			file: staged.file,
			durationMs: staged.durationMs,
			coverBlob: edits.coverBlob,
			artistIds: edits.artistIds,
			playWhenReady: staged.playWhenReady,
		});
		this.settleReviewedCount();
		this.emit();
		void this.work();
	}

	/** Discard a staged file without uploading it. */
	skip(stagedId: string): void {
		if (!this.staged.some((s) => s.id === stagedId)) return;
		this.staged = this.staged.filter((s) => s.id !== stagedId);
		this.reviewedCount += 1;
		this.settleReviewedCount();
		this.emit();
	}

	/** Remove a failed upload's row. Only failed items can be dismissed — an
	 * in-flight upload keeps its row until it settles. */
	dismiss(id: string): void {
		const item = this.items.find((i) => i.id === id);
		if (!item || item.status !== "error") return;
		this.items = this.items.filter((i) => i !== item);
		this.emit();
	}

	/** Drop every staged file (Esc/X on the review dialog, or logout). */
	cancelAll(): void {
		if (this.staged.length === 0) return;
		this.staged = [];
		this.reviewedCount = 0;
		this.emit();
	}

	/**
	 * Upload every remaining staged file with its prefilled title and cover
	 * ("Upload all" button). Each file's proposed artist is still linked — the
	 * suggestion is opted in by default, so skipping it here would silently drop
	 * the artist of every file the user didn't review one by one. Resolving is
	 * best-effort: a failure uploads the track without the artist rather than
	 * stalling a bulk action behind an error the user can't see.
	 */
	async confirmAll(): Promise<void> {
		for (const staged of [...this.staged]) {
			let artistIds: number[] = [];
			if (staged.suggestedArtist) {
				const resolved = await artistService.resolveOrCreate(
					staged.suggestedArtist,
				);
				if (resolved.ok) artistIds = [resolved.id];
			}
			this.confirm(staged.id, {
				title: staged.title,
				artistIds,
				coverBlob: staged.coverBlob,
			});
		}
	}

	/** Once the batch is fully reviewed, the next one starts back at "1 of M". */
	private settleReviewedCount(): void {
		if (this.staged.length === 0) this.reviewedCount = 0;
	}

	private async work(): Promise<void> {
		if (this.working) return;
		this.working = true;
		this.autoPlayed = false; // one auto-start per drain — see playLanded
		try {
			let entry: QueueEntry | undefined;
			while ((entry = this.queue.shift())) {
				await this.upload(entry);
			}
		} finally {
			this.working = false;
		}
	}

	private async upload(entry: QueueEntry): Promise<void> {
		const { item, file, durationMs, coverBlob, artistIds, playWhenReady } =
			entry;
		// Taken before the POST, not before the refresh below: the track has to be
		// recognisable in whichever listing first carries it, and a refresh this
		// upload didn't start can be the one that does.
		const known = playWhenReady ? libraryService.trackIds() : null;
		try {
			const result = await bun.uploadTrack({
				title: item.title,
				durationMs,
				dataBase64: await blobToBase64(file),
				coverBase64: coverBlob ? await blobToBase64(coverBlob) : undefined,
				artistIds,
			});
			if (result.ok) {
				// The track only leaves the pending list once the library refresh
				// has actually put it back in the queue as a streaming track —
				// dropping the placeholder first would make an uploaded track
				// vanish from the UI if that refresh failed.
				if (await libraryService.refresh()) {
					this.items = this.items.filter((i) => i !== item);
					if (known) this.playLanded(known);
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
		this.emit();
	}

	/**
	 * Start the track this upload just put in the library — the newest one the
	 * library has gained since the upload began. A library that has gained
	 * nothing plays nothing rather than something else: the refresh that carries
	 * the track hasn't landed, so there is no track to name yet.
	 *
	 * At most one track starts per drain of the upload queue: a batch of imports
	 * confirmed one after another would otherwise each cut off the one before it
	 * seconds in, leaving whichever happened to upload last playing.
	 */
	private playLanded(known: ReadonlySet<string>): void {
		if (this.autoPlayed) return;
		const landed = libraryService.newestSince(known);
		if (!landed) return;
		this.autoPlayed = true;
		libraryService.playTrack(landed.id);
	}

	private emit(): void {
		this.snapshot = {
			uploads: [...this.items],
			staged: [...this.staged],
			reviewedCount: this.reviewedCount,
		};
		this.subscribers.forEach((notify) => notify());
	}
}

/**
 * A title the server will accept: bounded at both ends, since the contract
 * takes 1…MAX_NAME_LENGTH characters. What a tag or a file name yields reaches
 * the upload without passing the review dialog's input — "Upload all" confirms
 * a staged title as it stands — so it is bounded where it is derived rather
 * than where it is edited. A file named `.mp3` has no stem to fall back on.
 */
function clampTitle(title: string): string {
	return title.trim().slice(0, MAX_NAME_LENGTH) || "Untitled";
}

/**
 * Tag durations are float seconds and best-effort. A damaged file reports no
 * duration, a broken VBR header an absurd one, and both reach the contract as
 * int32 milliseconds — where `NaN` and a century-long track are a 400 whose
 * message tells the user nothing they can act on.
 */
function clampDuration(seconds: number | undefined): number {
	const ms = Math.round((seconds ?? 0) * 1000);
	if (!Number.isFinite(ms) || ms < 0) return 0;
	return Math.min(ms, MAX_DURATION_MS);
}

/** App-wide singleton — uploads must survive component unmounts. */
export const uploadService = new UploadService();
