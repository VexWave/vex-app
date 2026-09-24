import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Updater } from "electrobun/bun";
import type {
	AppUpdateProgressMessage,
	AppUpdateResult,
	RpcResult,
} from "../shared/rpcSchema";
import {
	type InstallerRelease,
	RELEASES_LATEST_API,
	isNewer,
	pickInstaller,
} from "./appRelease";
import { describeError } from "./BinaryManager";
import { downloadToFile, fetchLatestRelease } from "./download";
import { installRoots, launchDetached, literal } from "./detachedHelper";

export class AppUpdater {
	private release: InstallerRelease | null = null;
	private downloading = false;
	private downloaded: string | null = null;

	constructor(
		private readonly proxy: () => string | undefined,
		private readonly send: (msg: AppUpdateProgressMessage) => void,
	) {}

	get isBusy(): boolean {
		return this.downloading;
	}

	async check(): Promise<AppUpdateResult> {
		const none: AppUpdateResult = { latestVersion: null };
		try {
			const roots = await installRoots();
			if (roots?.channel !== "stable") return none;
			const { version } = await Updater.getLocalInfo();
			const release = pickInstaller(
				await fetchLatestRelease(RELEASES_LATEST_API, this.proxy()),
			);
			if (!release || !isNewer(release.version, version)) return none;
			this.release = release;
			return { latestVersion: release.version };
		} catch {
			return none;
		}
	}

	startDownload(): RpcResult {
		const release = this.release;
		if (!release) return { ok: false, error: "There is no update to download." };
		if (this.downloading) {
			return { ok: false, error: "The update is already downloading." };
		}
		this.downloading = true;
		this.downloaded = null;
		this.download(release)
			.then(
				(installer) => {
					this.downloaded = installer;
					this.send({ type: "ready" });
				},
				(err) => this.send({ type: "failed", error: describeError(err) }),
			)
			.finally(() => {
				this.downloading = false;
			});
		return { ok: true };
	}

	async install(): Promise<RpcResult> {
		const installer = this.downloaded;
		if (!installer || !(await Bun.file(installer).exists())) {
			return { ok: false, error: "The update isn't downloaded yet." };
		}
		const roots = await installRoots();
		if (!roots) {
			return {
				ok: false,
				error: "Only an installed copy of VexWave can update itself.",
			};
		}
		const channelDir = path.join(roots.install, roots.channel);
		return launchDetached(
			"updater",
			channelDir,
			updateWorker(installer, channelDir),
			"nothing changed",
		);
	}

	private async download(release: InstallerRelease): Promise<string> {
		const target = path.join(
			os.tmpdir(),
			`VexWave-Setup-${release.version}.exe`,
		);
		if (await isVerifiedCopy(target, release)) return target;
		try {
			const hasher = new Bun.CryptoHasher("sha256");
			const receivedBytes = await downloadToFile(release.url, target, {
				proxy: this.proxy(),
				onProgress: (receivedBytes, totalBytes) =>
					this.send({
						type: "progress",
						receivedBytes,
						totalBytes: totalBytes ?? release.size,
					}),
				onChunk: (chunk) => hasher.update(chunk),
			});
			if (release.size !== undefined && receivedBytes !== release.size) {
				throw new Error("The download ended early. Try again.");
			}
			if (release.sha256 && hasher.digest("hex") !== release.sha256) {
				throw new Error(
					"The downloaded installer doesn't match the release's checksum.",
				);
			}
			return target;
		} catch (err) {
			await rm(target, { force: true }).catch(() => {});
			throw err;
		}
	}
}

async function isVerifiedCopy(
	target: string,
	release: InstallerRelease,
): Promise<boolean> {
	const file = Bun.file(target);
	if (!release.sha256 || file.size !== release.size) return false;
	if (!(await file.exists())) return false;
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of file.stream()) hasher.update(chunk);
	return hasher.digest("hex") === release.sha256;
}

// electrobun's installer never relaunches the app.
function updateWorker(installer: string, channelDir: string): string[] {
	return [
		`$setup = ${literal(installer)}`,
		`$launcher = ${literal(path.join(channelDir, "app", "bin", "launcher.exe"))}`,
		"",
		"$proc = Start-Process -FilePath $setup -WindowStyle Hidden -Wait -PassThru",
		"if ($proc) { Note ('installer exited with ' + $proc.ExitCode) } else { Note 'installer did not start' }",
		"Remove-Item -LiteralPath $setup -Force",
		"",
		"if (Test-Path -LiteralPath $launcher) {",
		"\tStart-Process -FilePath $launcher -WorkingDirectory (Split-Path -Parent $launcher)",
		"\tNote 'relaunched'",
		"} else {",
		"\tNote 'no launcher to relaunch'",
		"}",
	];
}
