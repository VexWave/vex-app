import type {
	ImportedArtist,
	UrlImportProgressMessage,
} from "../../shared/rpcSchema";
import { formatMb } from "@/lib/utils";
import { bun, onBunMessage } from "./rpc";
import { uploadService } from "./UploadService";

/** Hosts yt-dlp reliably supports for this app; anything else is rejected
 * up-front instead of failing minutes into a download. */
const SUPPORTED_HOSTS = [
	"youtube.com",
	"youtu.be",
	"soundcloud.com",
] as const;

/**
 * Validate and normalize user input into an importable URL. Accepts scheme-less
 * input ("youtube.com/watch?v=…") and any subdomain of the supported hosts
 * (www., m., music., on.); returns null when the input isn't a YouTube or
 * SoundCloud link.
 */
export function parseImportUrl(raw: string): string | null {
	const input = raw.trim();
	if (!input) return null;
	let url: URL;
	try {
		url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();
	const supported = SUPPORTED_HOSTS.some(
		(known) => host === known || host.endsWith(`.${known}`),
	);
	return supported ? url.toString() : null;
}

export type ImportJobStep =
	| "starting"
	| "downloading"
	| "converting"
	| "staging"
	| "error";

/** One URL import, from RPC kickoff until it enters the upload-review flow. */
export interface ImportJob {
	/** Webview-minted UUID; also the bun-side job id. */
	id: string;
	url: string;
	/** Media title once yt-dlp resolved the page; null until then. */
	title: string | null;
	step: ImportJobStep;
	receivedBytes: number;
	/** null = size unknown (indeterminate progress). */
	totalBytes: number | null;
	/** Failure reason while step === "error". */
	error: string | null;
}

export interface ImportsState {
	imports: readonly ImportJob[];
}

/**
 * How far a download has got as a percentage, or null when that isn't a number
 * yet: the job isn't downloading, or the server never said how big the media is.
 * The pending row and the Discover card both draw a bar from it, and the status
 * line below rounds the same value.
 */
export function importPercent(job: ImportJob): number | null {
	return job.step === "downloading" && job.totalBytes
		? Math.min(100, (job.receivedBytes / job.totalBytes) * 100)
		: null;
}

/**
 * A job's status as a line of text. Lives here, next to the steps it names, so
 * the pending row in the track list and the Discover card a download was started
 * from describe the same job the same way.
 */
export function importStatusLabel(job: ImportJob): string {
	const percent = importPercent(job);
	switch (job.step) {
		case "starting":
			return "Preparing download…";
		case "downloading":
			return percent === null
				? `Downloading… ${formatMb(job.receivedBytes)}`
				: `Downloading… ${Math.round(percent)}%`;
		case "converting":
			return "Converting to MP3…";
		case "staging":
			return "Almost done…";
		case "error":
			return job.error ?? "Import failed";
	}
}

/**
 * Tracks URL imports (YouTube/SoundCloud → mp3 via the bun-side yt-dlp). The
 * `importFromUrl` RPC only starts a job; progress arrives as pushed
 * `urlImportProgress` messages. When a job finishes, the converted mp3 (title +
 * cover embedded as tags) is fetched from the loopback proxy and handed to
 * UploadService as a plain File — from there it's staged, reviewed and uploaded
 * exactly like a dropped local file. Jobs survive logout: nothing about a
 * download is session-scoped until the upload step.
 */
export class ImportService {
	private subscribers = new Set<() => void>();
	private jobs: ImportJob[] = [];
	private snapshot: ImportsState = { imports: [] };

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): ImportsState => this.snapshot;

	/**
	 * The job importing this (already parseImportUrl-normalized) URL, or null. At
	 * most one can exist — see `start` — which is what lets anything holding a URL
	 * find its download: a Discover hit shares no id with an import.
	 */
	jobFor(url: string): ImportJob | null {
		return this.jobs.find((job) => job.url === url) ?? null;
	}

	/**
	 * Start importing a (already parseImportUrl-normalized) URL. A failed attempt
	 * at the same URL is dropped rather than kept beside the new one: two rows for
	 * one link, one of them a dead error, is never what the retry meant — and it
	 * is what makes a URL enough to identify a download (`jobFor`).
	 */
	async start(url: string): Promise<void> {
		const job: ImportJob = {
			id: crypto.randomUUID(),
			url,
			title: null,
			step: "starting",
			receivedBytes: 0,
			totalBytes: null,
			error: null,
		};
		// The row exists before the RPC resolves, so pushed progress messages
		// can never reference an id the UI doesn't know yet.
		this.jobs = [
			...this.jobs.filter((old) => old.url !== url || old.step !== "error"),
			job,
		];
		this.emit();
		try {
			const result = await bun.importFromUrl({ importId: job.id, url });
			if (!result.ok) this.fail(job.id, result.error);
		} catch (err) {
			this.fail(
				job.id,
				err instanceof Error ? err.message : "Import failed to start",
			);
		}
	}

	/** Remove a failed job's row. */
	dismiss(jobId: string): void {
		this.jobs = this.jobs.filter((job) => job.id !== jobId);
		this.emit();
	}

	handleProgress(msg: UrlImportProgressMessage): void {
		switch (msg.type) {
			case "progress":
				this.patch(msg.importId, (job) => ({
					...job,
					step: msg.step,
					title: msg.title ?? job.title,
					receivedBytes: msg.receivedBytes ?? job.receivedBytes,
					totalBytes: msg.totalBytes ?? job.totalBytes,
				}));
				break;
			case "finished":
				void this.stage(msg.importId, msg.fileName, msg.fileUrl, msg.artist);
				break;
			case "failed":
				this.fail(msg.importId, msg.error);
				break;
		}
	}

	/**
	 * Pull the finished mp3 from the loopback proxy and feed it into the normal
	 * upload-review flow; the temp file is discarded bun-side either way.
	 */
	private async stage(
		jobId: string,
		fileName: string,
		fileUrl: string,
		artist: ImportedArtist | undefined,
	): Promise<void> {
		this.patch(jobId, (job) => ({ ...job, step: "staging" }));
		try {
			const res = await fetch(fileUrl);
			if (!res.ok) throw new Error(`Fetching the import failed (${res.status})`);
			const blob = await res.blob();
			const file = new File([blob], fileName, { type: "audio/mpeg" });
			// yt-dlp resolved the creator → propose them in the review dialog.
			await uploadService.enqueue([file], artist ?? null);
			this.dismiss(jobId);
			// Discard only after a successful hand-off — a staging failure must
			// not destroy the finished download (the next startup sweeps it).
			void bun.discardImport({ importId: jobId }).catch(() => {});
		} catch (err) {
			this.fail(
				jobId,
				err instanceof Error ? err.message : "Failed to load the import",
			);
		}
	}

	private fail(jobId: string, error: string): void {
		this.patch(jobId, (job) => ({ ...job, step: "error", error }));
	}

	private patch(jobId: string, update: (job: ImportJob) => ImportJob): void {
		if (!this.jobs.some((job) => job.id === jobId)) return;
		this.jobs = this.jobs.map((job) => (job.id === jobId ? update(job) : job));
		this.emit();
	}

	private emit(): void {
		this.snapshot = { imports: this.jobs };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — running imports must survive component unmounts. */
export const importService = new ImportService();

onBunMessage("urlImportProgress", (msg) => {
	importService.handleProgress(msg);
});
