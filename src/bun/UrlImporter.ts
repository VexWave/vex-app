import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type {
	ImportFromUrlParams,
	RpcResult,
	UrlImportProgressMessage,
	UrlImportStep,
} from "../shared/rpcSchema";
import { describeError, fileExists, type BinaryManager } from "./BinaryManager";
import {
	childEnv,
	cleanArtistName,
	cleanField,
	collectStderr,
	describeYtDlpFailure,
	readLines,
	readYtDlpOutput,
	YT_DLP_BASE_ARGS,
	ytDlpNumber,
} from "./ytDlp";

/**
 * Machine-readable markers injected via yt-dlp's --progress-template/--print so
 * progress can be parsed out of otherwise human-oriented stdout. yt-dlp prints
 * "NA" for unknown numeric fields.
 */
const TITLE_MARK = "VEX>T ";
const DOWNLOAD_MARK = "VEX>D ";
const POSTPROCESS_MARK = "VEX>P";
const ARTIST_MARK = "VEX>A "; // the media's creator (channel/uploader)
const CHANNEL_URL_MARK = "VEX>U "; // the creator's page, for the avatar lookup
const AVATAR_MARK = "VEX>I "; // %(thumbnails)j of the creator's channel page

/** Largest avatar we'll pull back over the RPC message. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** Cap on the whole avatar lookup so it can't stall an otherwise-done import. */
const AVATAR_LOOKUP_TIMEOUT_MS = 20_000;

/** Only ids the webview minted with crypto.randomUUID() touch the filesystem. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ImportJob {
	id: string;
	url: string;
}

/** Mutable metadata collected from yt-dlp's marker lines during a job. */
interface JobState {
	title: string | undefined;
	/** The media's creator: YouTube channel or SoundCloud uploader. */
	artist: string | undefined;
	/**
	 * The creator's avatar, started as soon as their page URL is printed (before
	 * the audio download begins) so the lookup overlaps it instead of delaying
	 * the finished message. Null while unstarted or for a non-YouTube creator.
	 */
	avatar: Promise<{ base64: string; mime: string } | null> | null;
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
		if (!this.binaries.isSupported) {
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
			...YT_DLP_BASE_ARGS,
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
			// The single artist to propose: whoever published the media. Platform
			// "artist" metadata is only a fallback — it packs co-credits into one
			// string in a format that differs per platform.
			"--print", `before_dl:${ARTIST_MARK}%(channel,uploader,artist,creator)s`,
			"--print", `before_dl:${CHANNEL_URL_MARK}%(channel_url,uploader_url)s`,
			"-o", path.join(this.importsDir, `${job.id}.%(ext)s`),
			job.url,
		];

		const proc = Bun.spawn([this.binaries.ytDlpPath(), ...args], {
			env: childEnv(binDir),
			stdout: "pipe",
			stderr: "pipe",
		});

		const state: JobState = {
			title: undefined,
			artist: undefined,
			avatar: null,
		};
		const stderrTail = collectStderr(proc.stderr);
		await this.parseStdout(proc.stdout, job.id, state, binDir);
		const exitCode = await proc.exited;

		if (exitCode !== 0 || !(await fileExists(outPath))) {
			throw new Error(await describeYtDlpFailure(exitCode, stderrTail));
		}

		// Started back at before_dl, so by now it has usually long resolved.
		const name = cleanArtistName(state.artist);
		const avatar = name ? await state.avatar : null;

		this.finishedFiles.set(job.id, outPath);
		this.sendProgress({
			type: "finished",
			importId: job.id,
			fileName: `${sanitizeFileName(state.title ?? "Imported track")}.mp3`,
			fileUrl: this.fileUrlFor(job.id),
			artist: name
				? { name, imageBase64: avatar?.base64, imageMime: avatar?.mime }
				: undefined,
		});
	}

	/**
	 * The creator's avatar, as YouTube itself serves it — no third-party lookup.
	 * It lives on the channel's "/about" page (a bare channel URL resolves to the
	 * first video's thumbnails instead), so this is a second, short yt-dlp run
	 * with the entry list suppressed. SoundCloud exposes no avatar through yt-dlp
	 * at all, so a non-YouTube creator page returns null without spawning
	 * anything. Purely decorative, so every failure — timeout, no avatar, an
	 * oversized or non-image response — resolves to null rather than throwing.
	 */
	private async fetchChannelAvatar(
		channelUrl: string,
		binDir: string,
	): Promise<{ base64: string; mime: string } | null> {
		const aboutUrl = youTubeAboutUrl(channelUrl);
		if (!aboutUrl) return null;

		const proc = Bun.spawn(
			[
				this.binaries.ytDlpPath(),
				...YT_DLP_BASE_ARGS,
				// Metadata only: --playlist-items 0 matches no entry, so nothing is
				// resolved beyond the channel page the `playlist:` print reads.
				"--flat-playlist", "--playlist-items", "0",
				"--print", `playlist:${AVATAR_MARK}%(thumbnails)j`,
				aboutUrl,
			],
			{ env: childEnv(binDir), stdout: "pipe", stderr: "ignore" },
		);
		const { stdout } = await readYtDlpOutput(proc, AVATAR_LOOKUP_TIMEOUT_MS);

		const line = stdout
			.split(/\r?\n/)
			.find((l) => l.startsWith(AVATAR_MARK));
		if (!line) return null;
		const imageUrl = pickAvatarUrl(line.slice(AVATAR_MARK.length));
		if (!imageUrl) return null;

		const res = await fetch(imageUrl, {
			signal: AbortSignal.timeout(AVATAR_LOOKUP_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const mime = res.headers.get("content-type")?.split(";")[0]?.trim();
		if (!mime?.startsWith("image/")) return null;
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) return null;
		return { base64: Buffer.from(bytes).toString("base64"), mime };
	}

	/** Streams stdout, turning marker lines into throttled progress messages. */
	private async parseStdout(
		stdout: ReadableStream<Uint8Array>,
		importId: string,
		state: JobState,
		binDir: string,
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
			} else if (line.startsWith(ARTIST_MARK)) {
				state.artist = cleanField(line.slice(ARTIST_MARK.length));
			} else if (line.startsWith(CHANNEL_URL_MARK)) {
				const channelUrl = cleanField(line.slice(CHANNEL_URL_MARK.length));
				// Kicked off here rather than at the end of the job so it runs
				// during the download; .catch keeps it from ever rejecting while
				// nothing is awaiting it yet.
				state.avatar = channelUrl
					? this.fetchChannelAvatar(channelUrl, binDir).catch(() => null)
					: null;
			} else if (line.startsWith(DOWNLOAD_MARK)) {
				const [received, total, estimate] = line
					.slice(DOWNLOAD_MARK.length)
					.split(" ")
					.map(ytDlpNumber);
				progress("downloading", {
					receivedBytes: received ?? 0,
					totalBytes: total ?? estimate,
				});
			} else if (line.startsWith(POSTPROCESS_MARK)) {
				progress("converting", undefined, true);
			}
		}
	}
}

/** The "/about" page of a YouTube creator URL; null for any other host. */
function youTubeAboutUrl(channelUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(channelUrl);
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();
	if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return null;
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/about`;
	return url.toString();
}

/**
 * The avatar URL out of a channel page's %(thumbnails)j. YouTube tags it
 * "avatar_uncropped" and also lists it by index; the size fallback exists so a
 * renamed/dropped tag degrades to the right image instead of to none — banners
 * are the only other thumbnails a channel carries, and they are never square.
 */
function pickAvatarUrl(rawJson: string): string | undefined {
	let thumbnails: { id?: string; url?: string; width?: number; height?: number }[];
	try {
		const parsed = JSON.parse(rawJson.trim());
		if (!Array.isArray(parsed)) return undefined;
		thumbnails = parsed.filter((t) => typeof t?.url === "string");
	} catch {
		return undefined;
	}
	const tagged = thumbnails.find((t) => t.id === "avatar_uncropped");
	if (tagged) return tagged.url;
	let best: { url?: string; width?: number } | undefined;
	for (const thumb of thumbnails) {
		const { width, height } = thumb;
		if (!width || !height || width !== height) continue;
		if (!best || width > (best.width ?? 0)) best = thumb;
	}
	return best?.url;
}

/** Strip characters Windows forbids in file names; the name is display-only. */
function sanitizeFileName(name: string): string {
	const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
	return cleaned || "Imported track";
}
