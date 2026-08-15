import { readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Updater } from "electrobun/bun";
import type { RpcResult, StorageLocation } from "../shared/rpcSchema";

/** The two shortcuts the Electrobun installer creates, relative to a known root. */
const SHORTCUTS: { root: string | undefined; segments: string[] }[] = [
	{
		root: process.env.APPDATA,
		segments: ["Microsoft", "Windows", "Start Menu", "Programs", "VexWave.lnk"],
	},
	{ root: process.env.USERPROFILE, segments: ["Desktop", "VexWave.lnk"] },
];

const UNINSTALL_KEY =
	"HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

/** How long the helper gives the app to exit before abandoning the job. */
const WAIT_SECONDS = 120;

/** How long it keeps at the install directory once nothing runs from it. */
const DELETE_SECONDS = 120;

/** How long to wait for the helper to report itself before giving up on it. */
const READY_TIMEOUT_MS = 8_000;
const READY_POLL_MS = 100;

/** Something the helper removes after the install directory has gone. */
interface Removal {
	kind: "dir" | "file";
	path: string;
}

interface Roots {
	/** `%LOCALAPPDATA%\app.vexwave` — every channel, not just the running one. */
	install: string;
	/** The bare identifier, which also names the registry uninstall key. */
	identifier: string;
}

/**
 * Removes VexWave from the machine: the install directory, the downloaded
 * binaries beside it, the shortcuts pointing at it, and the registry entry
 * naming it.
 *
 * None of it can happen from in here. Windows holds an executing image open,
 * and the app is running `launcher.exe`, `bun.exe` and a CEF helper per view out
 * of the very tree being removed, so the work goes to a detached helper that
 * outlives the app.
 *
 * Three things that helper must get right, all learned the hard way:
 *
 *   - **It waits for this process to exit before deleting anything.** Deleting
 *     around a live app takes whatever happens to be unlocked and leaves the
 *     rest, which is a half-removed install rather than a failed removal.
 *   - **It then stops whatever is still running out of the tree.** Quitting
 *     force-exits, which leaves the CEF helpers orphaned rather than ended, and
 *     a file one of them has mapped cannot be deleted at all.
 *   - **It is started outside this process's tree**, through WMI, so that
 *     whatever reaps the app's children on the way down cannot reap it too.
 *
 * And because a helper that never starts would mean quitting into a deletion
 * that never happens, it reports for duty before this side agrees to quit.
 */
export class Uninstaller {
	/**
	 * @param componentsDir The downloaded binaries' own directory, or null where
	 * the platform has none. Its parent is what gets removed — `imports/` is its
	 * sibling (`UrlImporter`), and both are ours.
	 */
	constructor(private readonly componentsDir: string | null) {}

	/** What would be deleted and how much room it takes, for the settings panel. */
	async describe(): Promise<{
		install: StorageLocation | null;
		components: StorageLocation | null;
	}> {
		const roots = await this.resolveRoots();
		const components = this.componentsRoot();
		return {
			install: roots ? await measure(roots.install) : null,
			components: components ? await measure(components) : null,
		};
	}

	/**
	 * Puts the helper in place and answers once it has confirmed it is running
	 * and waiting. The caller quits the app on success, which is the signal the
	 * helper is waiting for; on failure nothing has been touched and the app
	 * stays up to say so.
	 */
	async start(): Promise<RpcResult> {
		const roots = await this.resolveRoots();
		if (!roots) {
			return {
				ok: false,
				error:
					"VexWave can only uninstall an installed copy of itself, and this one is running from a development build.",
			};
		}

		// Everything but the install directory can go in any order once the app is
		// gone; the install directory is the one that has to be waited out.
		const rest: Removal[] = [];
		const components = this.componentsRoot();
		if (components) rest.push({ kind: "dir", path: components });
		for (const link of await this.strandedShortcuts(roots.install)) {
			rest.push({ kind: "file", path: link });
		}

		const stem = path.join(
			os.tmpdir(),
			`vexwave-uninstall-${Date.now().toString(36)}`,
		);
		const files = {
			worker: `${stem}-worker.ps1`,
			launcher: `${stem}-launch.ps1`,
			ready: `${stem}.ready`,
			log: `${stem}.log`,
		};

		// Machine-derived, all of it, but it is pasted into PowerShell literals
		// that a `'` would close, and into a command line where a `"` ends an
		// argument early.
		const written = [
			roots.install,
			process.execPath,
			...rest.map((entry) => entry.path),
			...Object.values(files),
		];
		if (written.some((target) => /["'\r\n]/.test(target))) {
			return {
				ok: false,
				error: "VexWave is installed under a path it can't safely remove.",
			};
		}

		try {
			await writeFile(files.worker, this.worker(roots, rest, files), "utf8");
			await writeFile(files.launcher, launcher(files), "utf8");
			// Not `cmd /c start`: that leaves the helper inside this process's tree,
			// where it is killed partway through its work when the app goes down.
			// WMI has the service create it instead, so it belongs to nothing here.
			Bun.spawn(
				[
					"powershell.exe",
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					files.launcher,
				],
				{ stdio: ["ignore", "ignore", "ignore"] },
			);
		} catch (err) {
			return {
				ok: false,
				error:
					err instanceof Error
						? `Couldn't start the uninstaller: ${err.message}`
						: "Couldn't start the uninstaller.",
			};
		}

		if (!(await waitForFile(files.ready, READY_TIMEOUT_MS))) {
			// Quitting now would close the app on a removal that will never run.
			await rm(files.worker, { force: true }).catch(() => {});
			return {
				ok: false,
				error: `The uninstaller didn't start, so nothing was removed. Its log is at ${files.log}`,
			};
		}
		return { ok: true };
	}

	/**
	 * The helper itself. It logs every branch it takes: by the time any of this
	 * runs there is no app left to report a failure through.
	 */
	private worker(
		roots: Roots,
		rest: Removal[],
		files: { ready: string; log: string },
	): string {
		return [
			"$ErrorActionPreference = 'SilentlyContinue'",
			`$log = '${files.log}'`,
			`$ready = '${files.ready}'`,
			`$install = '${roots.install}'`,
			`$exe = '${process.execPath}'`,
			"",
			`function Note($m) { "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m | Out-File -LiteralPath $log -Append -Encoding utf8 }`,
			// A script is read into memory before it runs, so it can remove itself.
			"function Finish { Remove-Item -LiteralPath $ready -Force; Remove-Item -LiteralPath $PSCommandPath -Force; exit }",
			"",
			`Note 'waiting for pid ${process.pid}'`,
			// The handshake: until this exists, the app must not quit.
			"'ready' | Out-File -LiteralPath $ready -Encoding ascii",
			"",
			`$deadline = (Get-Date).AddSeconds(${WAIT_SECONDS})`,
			`while (Get-Process -Id ${process.pid}) {`,
			"\tif ((Get-Date) -gt $deadline) { Note 'app never exited; nothing removed'; Finish }",
			"\tStart-Sleep -Milliseconds 500",
			"}",
			"",
			// Quitting force-exits, which orphans the CEF helpers rather than
			// ending them, and one of those keeps CEF\BrowserMetrics\*.pma mapped
			// for as long as it lives. A mapped file cannot be deleted, so waiting
			// it out is not an option. Nothing here is worth waiting for anyway:
			// these are the processes of the app being removed.
			`$running = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($install + '\\', 'OrdinalIgnoreCase') })`,
			"if ($running) {",
			"\tNote ('stopping ' + (($running | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join ', '))",
			"\t$running | Stop-Process -Force",
			"\tStart-Sleep -Seconds 2",
			"}",
			"",
			`$deadline = (Get-Date).AddSeconds(${DELETE_SECONDS})`,
			"while ($true) {",
			"\tRemove-Item -LiteralPath $install -Recurse -Force",
			"\tif (-not (Test-Path -LiteralPath $install)) { break }",
			"\tif ((Get-Date) -gt $deadline) { break }",
			"\tStart-Sleep -Seconds 1",
			"}",
			"",
			"if (Test-Path -LiteralPath $install) {",
			// The executable is what tells a removal that never happened from one
			// that finished around something it couldn't take. Only the first is
			// worth leaving alone: shortcuts into a gutted install point nowhere.
			"\tif (Test-Path -LiteralPath $exe) { Note 'install directory would not go; nothing else touched'; Finish }",
			"\tNote 'install directory left a remnant; removing the rest anyway'",
			"} else {",
			"\tNote 'install directory removed'",
			"}",
			"",
			...rest.map(({ kind, path: target }) =>
				kind === "file"
					? `Remove-Item -LiteralPath '${target}' -Force`
					: `Remove-Item -LiteralPath '${target}' -Recurse -Force`,
			),
			// Absent unless the user imported the installer's own .reg file, so
			// this failing is the ordinary case rather than a fault.
			`Remove-Item -LiteralPath '${UNINSTALL_KEY}\\${roots.identifier}' -Recurse -Force`,
			"Note 'done'",
			"Finish",
			"",
		].join("\r\n");
	}

	/**
	 * `%LOCALAPPDATA%\<identifier>`, or null when this copy has no business
	 * deleting it.
	 *
	 * Nothing here is a formality. `getLocalInfo` answers with empty strings when
	 * it can't read `version.json`, and joining those resolves to
	 * `%LOCALAPPDATA%` itself — the one directory this must never be pointed at.
	 * Requiring the running executable to sit inside the channel folder is what
	 * proves the tree is this app's own, and is also what makes a dev build
	 * refuse: `bun run dev:hmr` runs from the repository, and only a browser
	 * cache is written under the `dev` channel.
	 */
	private async resolveRoots(): Promise<Roots | null> {
		if (process.platform !== "win32") return null;
		const { identifier, channel } = await Updater.getLocalInfo();
		if (!identifier || !channel) return null;
		// The identifier also names a registry key, so nothing but a plain name.
		if (!/^[A-Za-z0-9._-]+$/.test(identifier)) return null;

		const install = path.join(localAppData(), identifier);
		const running = path.join(install, channel);
		if (!isInside(running, process.execPath)) return null;
		return { install, identifier };
	}

	/** `%LOCALAPPDATA%\VexWave` — the binaries' directory and `imports/` beside it. */
	private componentsRoot(): string | null {
		return this.componentsDir ? path.dirname(this.componentsDir) : null;
	}

	/**
	 * The shortcuts that would be left pointing at nothing. A `.lnk` stores its
	 * target inside itself, so one is claimed only when the install path appears
	 * in its bytes — in either encoding, since the format holds the path both
	 * ways. Matching on the filename alone would delete a shortcut somebody made
	 * for something else entirely.
	 *
	 * A Desktop redirected elsewhere keeps its shortcut; a dead icon is a smaller
	 * cost than resolving shell folders to hunt for it.
	 */
	private async strandedShortcuts(install: string): Promise<string[]> {
		const found: string[] = [];
		for (const { root, segments } of SHORTCUTS) {
			if (!root) continue;
			const link = path.join(root, ...segments);
			const file = Bun.file(link);
			if (!(await file.exists())) continue;
			const bytes = Buffer.from(await file.arrayBuffer());
			const points =
				bytes.includes(Buffer.from(install, "latin1")) ||
				bytes.includes(Buffer.from(install, "utf16le"));
			if (points) found.push(link);
		}
		return found;
	}
}

/**
 * Hands the worker to WMI, whose service creates it as its own child — the
 * point of the exercise, since a process started from here belongs to this
 * app's tree and dies with it. `Start-Process` is the fallback for a machine
 * where WMI won't answer; it is still better than not starting at all, and the
 * caller finds out either way by whether the worker reports in.
 */
function launcher(files: { worker: string; launcher: string }): string {
	return [
		"$ErrorActionPreference = 'SilentlyContinue'",
		`$worker = '${files.worker}'`,
		"$flags = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File')",
		`$line = 'powershell.exe ' + ($flags -join ' ') + ' "' + $worker + '"'`,
		"$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line }",
		"if (-not $result -or $result.ReturnValue -ne 0) {",
		"\tStart-Process -FilePath 'powershell.exe' -ArgumentList ($flags + $worker) -WindowStyle Hidden",
		"}",
		`Remove-Item -LiteralPath '${files.launcher}' -Force`,
		"",
	].join("\r\n");
}

/** Polls for a file the helper writes to say it is alive and waiting. */
async function waitForFile(target: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await Bun.file(target).exists()) return true;
		await Bun.sleep(READY_POLL_MS);
	}
	return false;
}

function localAppData(): string {
	return (
		process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local")
	);
}

/** Whether `child` lies within `parent`, both compared as resolved paths. */
function isInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return (
		relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	);
}

/** A directory's path and total size, or null when it isn't there at all. */
async function measure(dir: string): Promise<StorageLocation | null> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
	if (!entries) return null;
	let bytes = 0;
	for (const entry of entries) {
		const child = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			bytes += (await measure(child))?.bytes ?? 0;
		} else if (entry.isFile()) {
			// A file that vanishes mid-walk (a cache eviction, a finished import)
			// costs its size from the total, not the whole measurement.
			bytes += await stat(child)
				.then((info) => info.size)
				.catch(() => 0);
		}
	}
	return { path: dir, bytes };
}
