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
	"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

/** One-second tries the helper gives the app to exit before abandoning the job. */
const WAIT_ATTEMPTS = 120;

/** One-second tries at the install directory once the app is actually gone. */
const DELETE_ATTEMPTS = 60;

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
 * Two things that helper must get right, both learned the hard way:
 *
 *   - **It waits for this process to exit before deleting anything.** Deleting
 *     around a live app takes whatever happens to be unlocked and leaves the
 *     rest, which is a half-removed install rather than a failed removal.
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
			worker: `${stem}.cmd`,
			launcher: `${stem}.ps1`,
			ready: `${stem}.ready`,
			log: `${stem}.log`,
		};

		// Machine-derived, all of it, but it is pasted into a batch file where a
		// quote ends an argument early and a `%` expands, and into a PowerShell
		// literal that a `'` would close.
		const written = [
			roots.install,
			...rest.map((entry) => entry.path),
			...Object.values(files),
		];
		if (written.some((target) => /["'%\r\n]/.test(target))) {
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
	 * The helper itself. Written as a batch file because `cmd` is the one
	 * interpreter that is certainly present and certainly unaffected by
	 * execution policy, and it logs every branch it takes: by the time any of
	 * this runs there is no app left to report a failure through.
	 */
	private worker(
		roots: Roots,
		rest: Removal[],
		files: { worker: string; ready: string; log: string },
	): string {
		const image = path.basename(process.execPath);
		return [
			"@echo off",
			`set "LOG=${files.log}"`,
			`>>"%LOG%" echo [%DATE% %TIME%] waiting for ${image} (pid ${process.pid})`,
			// The handshake: until this exists, the app must not quit.
			`>"${files.ready}" echo ready`,
			"set /a TRIES=0",
			"",
			":wait",
			// Filtered to the one pid, so the image name is only there to tell a
			// real row from tasklist's "no tasks match" notice.
			`tasklist /fi "PID eq ${process.pid}" /nh 2>nul | find /i "${image}" >nul`,
			"if errorlevel 1 goto gone",
			"set /a TRIES+=1",
			`if %TRIES% GEQ ${WAIT_ATTEMPTS} goto abandon`,
			// `timeout` reads from the console this helper was started without and
			// fails outright, so pinging the loopback is the sleep that works.
			"ping -n 2 127.0.0.1 >nul",
			"goto wait",
			"",
			":gone",
			'>>"%LOG%" echo [%TIME%] app exited; removing',
			// The images are unmapped as the process dies, not before it.
			"ping -n 3 127.0.0.1 >nul",
			"set /a TRIES=0",
			"",
			":sweep",
			// A trailing slash is what makes `if exist` ask about the directory.
			`if not exist "${roots.install}\\" goto swept`,
			"set /a TRIES+=1",
			`if %TRIES% GTR ${DELETE_ATTEMPTS} goto stuck`,
			`rmdir /s /q "${roots.install}" 2>nul`,
			"ping -n 2 127.0.0.1 >nul",
			"goto sweep",
			"",
			":swept",
			'>>"%LOG%" echo [%TIME%] install directory removed',
			...rest.map(({ kind, path: target }) =>
				kind === "file"
					? `del /f /q "${target}" 2>nul`
					: `rmdir /s /q "${target}" 2>nul`,
			),
			// Absent unless the user imported the installer's own .reg file, so
			// this failing is the ordinary case rather than a fault.
			`reg delete "${UNINSTALL_KEY}\\${roots.identifier}" /f >nul 2>nul`,
			'>>"%LOG%" echo [%TIME%] done',
			"goto finish",
			"",
			":stuck",
			// Something still holds the tree, so the rest is left alone too: a
			// half-removed install is worse than one that reports it is still here.
			'>>"%LOG%" echo [%TIME%] install directory would not go; nothing else touched',
			"goto finish",
			"",
			":abandon",
			'>>"%LOG%" echo [%TIME%] app never exited; nothing removed',
			"",
			":finish",
			`del /f /q "${files.ready}" 2>nul`,
			// A batch file is read as it runs, so jumping past its end frees the
			// handle and lets the last command remove the file being executed.
			'(goto) 2>nul & del "%~f0"',
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
		`$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "' + $worker + '"' }`,
		"if (-not $result -or $result.ReturnValue -ne 0) {",
		"\tStart-Process -FilePath 'cmd.exe' -ArgumentList '/c', $worker -WindowStyle Hidden",
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
