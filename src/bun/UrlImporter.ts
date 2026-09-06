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

const TITLE_MARK = "VEX>T ";
const DOWNLOAD_MARK = "VEX>D ";
const POSTPROCESS_MARK = "VEX>P";
const ARTIST_MARK = "VEX>A ";
const CHANNEL_URL_MARK = "VEX>U ";
const AVATAR_MARK = "VEX>I ";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_LOOKUP_TIMEOUT_MS = 20_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ImportJob {
	id: string;
	url: string;
}

interface JobState {
	title: string | undefined;
	artist: string | undefined;
	avatar: Promise<{ base64: string; mime: string } | null> | null;
}

export class UrlImporter {
	private readonly importsDir: string;
	private queue: ImportJob[] = [];
	private running = false;
	private readonly cleanupDone: Promise<void>;
	private finishedFiles = new Map<string, string>();

	constructor(
		private readonly binaries: BinaryManager,
		private readonly sendProgress: (msg: UrlImportProgressMessage) => void,
		private readonly fileUrlFor: (importId: string) => string,
	) {
		this.importsDir = path.join(path.dirname(binaries.binDir), "imports");
		this.cleanupDone = binaries.binDir ? this.sweepStaleFiles() : Promise.resolve();
	}

	get isActive(): boolean {
		return this.running || this.queue.length > 0;
	}

	filePathFor(importId: string): string | null {
		return this.finishedFiles.get(importId) ?? null;
	}

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

	async discard({ importId }: { importId: string }): Promise<RpcResult> {
		const filePath = this.finishedFiles.get(importId);
		this.finishedFiles.delete(importId);
		if (filePath) await rm(filePath, { force: true }).catch(() => {});
		return { ok: true };
	}

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
		} catch {}
	}

	private async runJob(job: ImportJob): Promise<void> {
		this.sendProgress({ type: "progress", importId: job.id, step: "starting" });
		const outPath = path.join(this.importsDir, `${job.id}.mp3`);
		const binDir = this.binaries.binDir;

		const args = [
			...YT_DLP_BASE_ARGS,
			"--no-playlist",
			"--playlist-items", "1",
			"-x", "--audio-format", "mp3", "--audio-quality", "0",
			"--embed-metadata", "--embed-thumbnail",
			"--ffmpeg-location", binDir,
			"--progress", "--newline",
			"--progress-template",
			`download:${DOWNLOAD_MARK}%(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s`,
			"--progress-template", `postprocess:${POSTPROCESS_MARK}`,
			"--print", `before_dl:${TITLE_MARK}%(title)s`,
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

		const name = cleanArtistName(state.artist);
		const avatar = name ? await state.avatar : null;

		this.finishedFiles.set(job.id, outPath);
		this.sendProgress({
			type: "finished",
			importId: job.id,
			fileName: `${sanitizeFileName(state.title, "Imported track")}.mp3`,
			fileUrl: this.fileUrlFor(job.id),
			artist: name
				? { name, imageBase64: avatar?.base64, imageMime: avatar?.mime }
				: undefined,
		});
	}

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

export function sanitizeFileName(
	name: string | undefined,
	fallback: string,
): string {
	const cleaned = (name ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
	return cleaned || fallback;
}
