import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	BinaryName,
	BinaryProgressMessage,
	BinaryStatusResult,
	RpcResult,
	YtDlpUpdateResult,
} from "../shared/rpcSchema";

const YT_DLP_LATEST_API =
	"https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";

interface DownloadPart {
	url: string;
	kind: "raw" | "zip";
	files: { entry?: string; dest: string }[];
}

interface BinaryManifest {
	ytDlp?: { version?: string };
	ffmpeg?: { installed: true };
	deno?: { installed: true };
}

const ALL_BINARIES: BinaryName[] = ["ytDlp", "ffmpeg", "deno"];

function defaultBinDir(): string | null {
	if (process.platform === "win32") {
		const localAppData =
			process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
		return path.join(localAppData, "VexWave", "bin");
	}
	if (process.platform === "darwin") {
		return path.join(
			os.homedir(),
			"Library",
			"Application Support",
			"VexWave",
			"bin",
		);
	}
	return null;
}

export class BinaryManager {
	readonly binDir: string;
	private readonly unsupported: string | null;
	private readonly tmpDir: string;
	private installTask: Promise<void> | null = null;

	constructor(
		private readonly sendProgress: (msg: BinaryProgressMessage) => void,
		private readonly proxy: () => string | undefined,
	) {
		const dir = defaultBinDir();
		this.unsupported = dir
			? null
			: `Unsupported platform "${process.platform}" — only Windows and macOS are supported.`;
		this.binDir = dir ?? "";
		this.tmpDir = path.join(this.binDir, ".tmp");
	}

	// Windows can't overwrite a running exe, so everything that spawns yt-dlp is
	// refused while an install run replaces binaries.
	get isBusy(): boolean {
		return this.installTask !== null;
	}

	get isSupported(): boolean {
		return this.unsupported === null;
	}

	ytDlpPath(): string {
		return this.destPath(this.exe("yt-dlp"));
	}

	ffmpegPath(): string {
		return this.destPath(this.exe("ffmpeg"));
	}

	ffprobePath(): string {
		return this.destPath(this.exe("ffprobe"));
	}

	denoPath(): string {
		return this.destPath(this.exe("deno"));
	}

	async getStatus(): Promise<BinaryStatusResult> {
		if (this.unsupported) return { ok: false, error: this.unsupported };
		try {
			const { installed, missing, manifest } = await this.statusOnDisk();
			return {
				ok: true,
				installed,
				missing,
				ytDlpVersion: installed.includes("ytDlp")
					? manifest.ytDlp?.version
					: undefined,
			};
		} catch (err) {
			return { ok: false, error: describeError(err) };
		}
	}

	startInstall(proxy?: string): RpcResult {
		return this.startRun(null, proxy);
	}

	startYtDlpUpdate(): RpcResult {
		return this.startRun(["ytDlp"], this.proxy());
	}

	async checkYtDlpUpdate(): Promise<YtDlpUpdateResult> {
		const none: YtDlpUpdateResult = { ok: true, updateAvailable: false };
		if (this.unsupported) return none;
		try {
			const manifest = await this.readManifest();
			const installedVersion = manifest.ytDlp?.version;
			if (!installedVersion) return none;
			const res = await fetch(YT_DLP_LATEST_API, {
				headers: { Accept: "application/vnd.github+json" },
				proxy: this.proxy(),
			});
			if (!res.ok) return none;
			const release = (await res.json()) as { tag_name?: string };
			const latestVersion = release.tag_name;
			if (!latestVersion || latestVersion === installedVersion) return none;
			return { ok: true, updateAvailable: true, latestVersion, installedVersion };
		} catch {
			return none;
		}
	}

	private startRun(
		binaries: BinaryName[] | null,
		proxy: string | undefined,
	): RpcResult {
		if (this.unsupported) return { ok: false, error: this.unsupported };
		if (this.installTask) return { ok: true };
		this.installTask = this.runInstall(binaries, proxy).finally(() => {
			this.installTask = null;
		});
		return { ok: true };
	}

	private async runInstall(
		requested: BinaryName[] | null,
		proxy: string | undefined,
	): Promise<void> {
		let current: BinaryName = requested?.[0] ?? "ytDlp";
		try {
			await mkdir(this.binDir, { recursive: true });
			await rm(this.tmpDir, { recursive: true, force: true });
			await mkdir(this.tmpDir, { recursive: true });

			const binaries =
				requested ?? (await this.statusOnDisk()).missing;
			for (const binary of binaries) {
				current = binary;
				await this.installOne(binary, proxy);
				this.sendProgress({ type: "binaryInstalled", binary });
			}
			this.sendProgress({ type: "finished" });
		} catch (err) {
			this.sendProgress({
				type: "failed",
				binary: current,
				error: describeError(err),
			});
		} finally {
			await rm(this.tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	private async installOne(
		binary: BinaryName,
		proxy: string | undefined,
	): Promise<void> {
		const parts = this.partsFor(binary);
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const filePath = await this.downloadWithProgress(
				part,
				binary,
				i + 1,
				parts.length,
				proxy,
			);
			if (part.kind === "raw") {
				await this.moveIntoBin(filePath, part.files[0].dest);
			} else {
				this.sendProgress({
					type: "progress",
					binary,
					step: "extracting",
					receivedBytes: 0,
					part: i + 1,
					partCount: parts.length,
				});
				const extractDir = path.join(this.tmpDir, `extract-${binary}-${i}`);
				await mkdir(extractDir, { recursive: true });
				await this.extractZip(filePath, extractDir);
				for (const file of part.files) {
					if (!file.entry) continue;
					await this.moveIntoBin(
						path.join(extractDir, ...file.entry.split("/")),
						file.dest,
					);
				}
			}
		}

		const manifest = await this.readManifest();
		if (binary === "ytDlp") {
			manifest.ytDlp = { version: await this.queryYtDlpVersion() };
		} else {
			manifest[binary] = { installed: true };
		}
		await this.writeManifest(manifest);
	}

	private async queryYtDlpVersion(): Promise<string | undefined> {
		try {
			const proc = Bun.spawn([this.ytDlpPath(), "--version"], {
				stdout: "pipe",
				stderr: "ignore",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) return undefined;
			const version = (await new Response(proc.stdout).text()).trim();
			return version || undefined;
		} catch {
			return undefined;
		}
	}

	private async downloadWithProgress(
		part: DownloadPart,
		binary: BinaryName,
		partIndex: number,
		partCount: number,
		proxy: string | undefined,
	): Promise<string> {
		const res = await fetch(part.url, { proxy });
		if (!res.ok || !res.body) {
			throw new Error(`Download failed (HTTP ${res.status}): ${part.url}`);
		}
		const contentLength = Number(res.headers.get("content-length"));
		const totalBytes =
			Number.isFinite(contentLength) && contentLength > 0
				? contentLength
				: undefined;

		const filePath = path.join(this.tmpDir, `${binary}-${partIndex}.download`);
		const sink = Bun.file(filePath).writer();
		let receivedBytes = 0;
		let lastEmit = 0;
		const emit = () =>
			this.sendProgress({
				type: "progress",
				binary,
				step: "downloading",
				receivedBytes,
				totalBytes,
				part: partIndex,
				partCount,
			});
		try {
			emit();
			const reader = res.body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				receivedBytes += value.byteLength;
				sink.write(value);
				const now = Date.now();
				if (now - lastEmit >= 150) {
					lastEmit = now;
					emit();
					await sink.flush();
				}
			}
			emit();
		} finally {
			await sink.end();
		}
		return filePath;
	}

	// bsdtar handles .zip; Windows 10+ ships it in System32, macOS in /usr/bin.
	private async extractZip(zipPath: string, extractDir: string): Promise<void> {
		const tar = process.platform === "win32" ? "tar" : "/usr/bin/tar";
		const proc = Bun.spawn([tar, "-xf", zipPath, "-C", extractDir], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(
				`Archive extraction failed (tar exit ${exitCode}): ${stderr.trim()}`,
			);
		}
	}

	private async moveIntoBin(from: string, destName: string): Promise<void> {
		const dest = this.destPath(destName);
		// Windows rename won't overwrite.
		await rm(dest, { force: true });
		await rename(from, dest);
		if (process.platform === "darwin") await chmod(dest, 0o755);
	}

	private async statusOnDisk(): Promise<{
		installed: BinaryName[];
		missing: BinaryName[];
		manifest: BinaryManifest;
	}> {
		const manifest = await this.readManifest();
		const installed: BinaryName[] = [];
		const missing: BinaryName[] = [];
		for (const binary of ALL_BINARIES) {
			const inManifest =
				binary === "ytDlp" ? manifest.ytDlp != null : manifest[binary] != null;
			const filesExist =
				inManifest &&
				(await Promise.all(
					this.expectedFiles(binary).map((file) =>
						fileExists(this.destPath(file)),
					),
				).then((results) => results.every(Boolean)));
			(filesExist ? installed : missing).push(binary);
		}
		return { installed, missing, manifest };
	}

	private manifestPath(): string {
		return path.join(this.binDir, "manifest.json");
	}

	private async readManifest(): Promise<BinaryManifest> {
		try {
			return await Bun.file(this.manifestPath()).json();
		} catch {
			return {};
		}
	}

	private async writeManifest(manifest: BinaryManifest): Promise<void> {
		const tmpPath = this.manifestPath() + ".tmp";
		await Bun.write(tmpPath, JSON.stringify(manifest, null, "\t"));
		await rm(this.manifestPath(), { force: true });
		await rename(tmpPath, this.manifestPath());
	}

	private partsFor(binary: BinaryName): DownloadPart[] {
		const arm64 = process.arch === "arm64";
		if (process.platform === "win32") {
			switch (binary) {
				case "ytDlp":
					return [
						{
							url: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${arm64 ? "yt-dlp_arm64.exe" : "yt-dlp.exe"}`,
							kind: "raw",
							files: [{ dest: "yt-dlp.exe" }],
						},
					];
				case "ffmpeg": {
					const variant = arm64 ? "winarm64" : "win64";
					const folder = `ffmpeg-master-latest-${variant}-gpl`;
					return [
						{
							url: `https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/${folder}.zip`,
							kind: "zip",
							files: [
								{ entry: `${folder}/bin/ffmpeg.exe`, dest: "ffmpeg.exe" },
								{ entry: `${folder}/bin/ffprobe.exe`, dest: "ffprobe.exe" },
							],
						},
					];
				}
				case "deno":
					return [
						{
							// No arm64 Windows build published; x64 runs under emulation.
							url: "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip",
							kind: "zip",
							files: [{ entry: "deno.exe", dest: "deno.exe" }],
						},
					];
			}
		}
		switch (binary) {
			case "ytDlp":
				return [
					{
						url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
						kind: "raw",
						files: [{ dest: "yt-dlp" }],
					},
				];
			case "ffmpeg":
				return [
					{
						url: "https://evermeet.cx/ffmpeg/getrelease/zip",
						kind: "zip",
						files: [{ entry: "ffmpeg", dest: "ffmpeg" }],
					},
					{
						url: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip",
						kind: "zip",
						files: [{ entry: "ffprobe", dest: "ffprobe" }],
					},
				];
			case "deno":
				return [
					{
						url: `https://github.com/denoland/deno/releases/latest/download/${arm64 ? "deno-aarch64-apple-darwin.zip" : "deno-x86_64-apple-darwin.zip"}`,
						kind: "zip",
						files: [{ entry: "deno", dest: "deno" }],
					},
				];
		}
	}

	private expectedFiles(binary: BinaryName): string[] {
		switch (binary) {
			case "ytDlp":
				return [this.exe("yt-dlp")];
			case "ffmpeg":
				return [this.exe("ffmpeg"), this.exe("ffprobe")];
			case "deno":
				return [this.exe("deno")];
		}
	}

	private exe(name: string): string {
		return process.platform === "win32" ? `${name}.exe` : name;
	}

	private destPath(fileName: string): string {
		return path.join(this.binDir, fileName);
	}
}

export async function fileExists(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

export function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
