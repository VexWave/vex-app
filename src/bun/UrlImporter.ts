import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type {
	ImportFromUrlParams,
	RpcResult,
	UrlImportProgressMessage,
	UrlImportStep,
} from "../shared/rpcSchema";
import { describeError, fileExists, type BinaryManager } from "./BinaryManager";

/**
 * Machine-readable markers injected via yt-dlp's --progress-template/--print so
 * progress can be parsed out of otherwise human-oriented stdout. yt-dlp prints
 * "NA" for unknown numeric fields.
 */
const TITLE_MARK = "VEX>T ";
const DOWNLOAD_MARK = "VEX>D ";
const POSTPROCESS_MARK = "VEX>P";

/** Only ids the webview minted with crypto.randomUUID() touch the filesystem. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ImportJob {
	id: string;
	url: string;
}

/**
 * Downloads a YouTube/SoundCloud URL with the managed yt-dlp, converting to mp3
 * via the managed ffmpeg and embedding the page's title/thumbnail as ID3 tags —
 * so the webview can stage the result exactly like a dropped local file, with
 * title and cover prefilled by the existing tag parsing. The managed bin dir is
 * prepended to the child's PATH, which is how yt-dlp finds deno (its JS runtime
 * for YouTube's player challenges) and ffprobe.
 *
 * Jobs run one at a time (bounds bandwidth, and a running yt-dlp.exe must never
 * be overwritten by the updater). Like BinaryManager, the RPC request only
 * queues a job: progress and completion are pushed as `urlImportProgress`
 * messages because a media download would blow the RPC timeout. Finished mp3s
 * sit in a temp dir until the webview fetched them (via the StreamProxy
 * loopback route) and calls `discard`; leftovers of killed or failed runs are
 * swept at the next startup.
 */
export class UrlImporter {
	private readonly importsDir: string;
	private queue: ImportJob[] = [];
	private running = false;
	private readonly cleanupDone: Promise<void>;
	/** importId → finished mp3 path, until the webview discards it. */
	private finishedFiles = new Map<string, string>();

	constructor(
		private readonly binaries: BinaryManager,
		private readonly sendProgress: (msg: UrlImportProgressMessage) => void,
		private readonly fileUrlFor: (importId: string) => string,
	) {
		// binDir is <...>/VexWave/bin; imports live beside it, not in the app dir.
		this.importsDir = path.join(path.dirname(binaries.binDir), "imports");
		this.cleanupDone = binaries.binDir ? this.sweepStaleFiles() : Promise.resolve();
	}

	/** True while any job is queued or running (blocks the yt-dlp updater). */
	get isActive(): boolean {
		return this.running || this.queue.length > 0;
	}

	/** Resolves a finished import's mp3 for the StreamProxy loopback route. */
	filePathFor(importId: string): string | null {
		return this.finishedFiles.get(importId) ?? null;
	}

	/** Queues a job and returns immediately; progress arrives via messages. */
	start({ importId, url }: ImportFromUrlParams): RpcResult {
		if (!this.binaries.binDir) {
			return { ok: false, error: "URL imports are not supported on this platform." };
		}
		if (!UUID_RE.test(importId)) {
			return { ok: false, error: "Invalid import id." };
		}
		try {
			new URL(url);
		} catch {
			return { ok: false, error: "Invalid URL." };
		}
		this.queue.push({ id: importId, url });
		void this.pump();
		return { ok: true };
	}

	/** Deletes a finished import's temp file (webview has fetched it). */
	async discard({ importId }: { importId: string }): Promise<RpcResult> {
		const filePath = this.finishedFiles.get(importId);
		this.finishedFiles.delete(importId);
		if (filePath) await rm(filePath, { force: true }).catch(() => {});
		return { ok: true };
	}

	// --- Job loop ---

	/** Detached task: every failure becomes a `failed` message, never a throw. */
	private async pump(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			let job: ImportJob | undefined;
			while ((job = this.queue.shift())) {
				try {
					await this.cleanupDone;
					await mkdir(this.importsDir, { recursive: true });
					await this.runJob(job);
				} catch (err) {
					this.sendProgress({
						type: "failed",
						importId: job.id,
						error: describeError(err),
					});
				}
			}
		} finally {
			this.running = false;
		}
	}

	/**
	 * Startup sweep of leftovers from killed or failed runs. Age-gated instead
	 * of a full wipe: another running instance shares this dir, and its active
	 * files (a .part being written, a finished mp3 awaiting the webview's
	 * fetch) are always fresh — only files nothing can still reference are old.
	 */
	private async sweepStaleFiles(): Promise<void> {
		const staleMs = 60 * 60 * 1000;
		try {
			const now = Date.now();
			for (const name of await readdir(this.importsDir)) {
				const filePath = path.join(this.importsDir, name);
				try {
					if (now - (await stat(filePath)).mtimeMs > staleMs) {
						await rm(filePath, { recursive: true, force: true });
					}
				} catch {}
			}
		} catch {} // dir doesn't exist yet
	}

	private async runJob(job: ImportJob): Promise<void> {
		this.sendProgress({ type: "progress", importId: job.id, step: "starting" });
		const outPath = path.join(this.importsDir, `${job.id}.mp3`);
		const binDir = this.binaries.binDir;

		const args = [
			// A URL that names both a video and a playlist means the video; a pure
			// playlist/set URL imports its first track (one job = one file).
			"--no-playlist",
			"--playlist-items", "1",
			"-x", "--audio-format", "mp3", "--audio-quality", "0",
			// Title/artist/thumbnail land as ID3 tags — the upload-review dialog
			// prefills from them via the same parsing as a dropped local file.
			"--embed-metadata", "--embed-thumbnail",
			"--ffmpeg-location", binDir,
			// --print implies quiet; --progress re-enables the (templated) bar.
			"--progress", "--newline",
			"--progress-template",
			`download:${DOWNLOAD_MARK}%(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s`,
			"--progress-template", `postprocess:${POSTPROCESS_MARK}`,
			"--print", `before_dl:${TITLE_MARK}%(title)s`,
			"-o", path.join(this.importsDir, `${job.id}.%(ext)s`),
			job.url,
		];

		// yt-dlp discovers deno (and ffprobe) by scanning PATH. The existing key
		// must be overwritten in place: a GUI-launched app inherits "Path", and
		// spreading plus a new "PATH" key would put BOTH in the child's block —
		// with the original (bin-dir-less) one winning the %PATH% lookup.
		const env: Record<string, string | undefined> = { ...process.env };
		const pathKey =
			Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
		env[pathKey] = binDir + path.delimiter + (env[pathKey] ?? "");

		const proc = Bun.spawn([this.binaries.ytDlpPath(), ...args], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});

		const state = { title: undefined as string | undefined };
		const stderrTail = this.collectStderr(proc.stderr);
		await this.parseStdout(proc.stdout, job.id, state);
		const exitCode = await proc.exited;

		if (exitCode !== 0 || !(await fileExists(outPath))) {
			throw new Error(await describeYtDlpFailure(exitCode, stderrTail));
		}

		this.finishedFiles.set(job.id, outPath);
		this.sendProgress({
			type: "finished",
			importId: job.id,
			fileName: `${sanitizeFileName(state.title ?? "Imported track")}.mp3`,
			fileUrl: this.fileUrlFor(job.id),
		});
	}

	/** Streams stdout, turning marker lines into throttled progress messages. */
	private async parseStdout(
		stdout: ReadableStream<Uint8Array>,
		importId: string,
		state: { title: string | undefined },
	): Promise<void> {
		let lastEmit = 0;
		const emit = (msg: UrlImportProgressMessage, always = false) => {
			const now = Date.now();
			if (!always && now - lastEmit < 150) return;
			lastEmit = now;
			this.sendProgress(msg);
		};
		const progress = (
			step: UrlImportStep,
			bytes?: { receivedBytes: number; totalBytes?: number },
			always = false,
		) =>
			emit(
				{ type: "progress", importId, step, title: state.title, ...bytes },
				always,
			);

		for await (const line of readLines(stdout)) {
			if (line.startsWith(TITLE_MARK)) {
				state.title = line.slice(TITLE_MARK.length).trim() || undefined;
				progress("starting", undefined, true);
			} else if (line.startsWith(DOWNLOAD_MARK)) {
				const [received, total, estimate] = line
					.slice(DOWNLOAD_MARK.length)
					.split(" ")
					.map(parseYtDlpNumber);
				progress("downloading", {
					receivedBytes: received ?? 0,
					totalBytes: total ?? estimate,
				});
			} else if (line.startsWith(POSTPROCESS_MARK)) {
				progress("converting", undefined, true);
			}
		}
	}

	/** Keeps only a bounded tail of stderr for the failure message. */
	private collectStderr(stderr: ReadableStream<Uint8Array>): Promise<string> {
		return new Response(stderr).text().then(
			(text) => text.slice(-4000),
			() => "",
		);
	}
}

/** yt-dlp prints "NA" (or nothing) for unknown fields, and floats for bytes. */
function parseYtDlpNumber(raw: string | undefined): number | undefined {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

async function describeYtDlpFailure(
	exitCode: number,
	stderrTail: Promise<string>,
): Promise<string> {
	const tail = await stderrTail;
	// yt-dlp prefixes its own failures with "ERROR:"; the last one is the cause.
	const errorLine = tail
		.split(/\r?\n/)
		.reverse()
		.find((line) => line.startsWith("ERROR:"));
	if (errorLine) return errorLine.replace(/^ERROR:\s*/, "");
	const lastLine = tail
		.split(/\r?\n/)
		.reverse()
		.find((line) => line.trim() !== "");
	return lastLine ?? `yt-dlp exited with code ${exitCode}`;
}

/** Strip characters Windows forbids in file names; the name is display-only. */
function sanitizeFileName(name: string): string {
	const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
	return cleaned || "Imported track";
}

async function* readLines(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? "";
		yield* lines;
	}
	if (buffer) yield buffer;
}
