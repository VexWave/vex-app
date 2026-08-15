import { readdir, stat, writeFile } from "node:fs/promises";
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

/** How long the helper keeps retrying the install directory, in one-second tries. */
const DELETE_ATTEMPTS = 60;

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
 * The install directory can't be deleted from inside it. Windows holds an
 * executing image open, and the app is running `launcher.exe`, `bun.exe` and a
 * CEF helper per view out of the very tree being removed, so `rm` fails on
 * every one of them until the process is gone. The deletion is therefore handed
 * to a detached `.cmd` that outlives the app and retries until the locks drop,
 * and the app quits behind it.
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
	 * Starts the removal and answers once the helper is running — everything it
	 * does happens after this process is gone, so there is nothing further to
	 * wait for. The caller quits the app.
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

		// Every path is machine-derived, but they are pasted into a batch file
		// where a quote would end the argument early and a `%` would expand.
		const paths = [roots.install, ...rest.map((entry) => entry.path)];
		if (paths.some((target) => /["%\r\n]/.test(target))) {
			return {
				ok: false,
				error: "VexWave is installed under a path it can't safely remove.",
			};
		}

		const script = path.join(
			os.tmpdir(),
			`vexwave-uninstall-${Date.now().toString(36)}.cmd`,
		);
		try {
			await writeFile(script, this.batch(roots, rest), "utf8");
			// `start` hands the helper to the shell, which is what detaches it: a
			// child of this process would be torn down with it before it had
			// waited out a single lock.
			Bun.spawn(["cmd.exe", "/c", "start", "", "/min", script], {
				stdio: ["ignore", "ignore", "ignore"],
			});
		} catch (err) {
			return {
				ok: false,
				error:
					err instanceof Error
						? `Couldn't start the uninstaller: ${err.message}`
						: "Couldn't start the uninstaller.",
			};
		}
		return { ok: true };
	}

	private batch(roots: Roots, rest: Removal[]): string {
		const install = roots.install;
		const lines = [
			"@echo off",
			// The app's own files stay locked until it exits, so the helper retries
			// rather than racing a shutdown it can't observe. A trailing slash is
			// what makes `if exist` ask about the directory itself.
			`for /l %%i in (1,1,${DELETE_ATTEMPTS}) do (`,
			`  if not exist "${install}\\" goto done`,
			`  rmdir /s /q "${install}" 2>nul`,
			// `timeout` reads from the console this helper was started without and
			// fails outright, so pinging the loopback is the sleep that works.
			"  ping -n 2 127.0.0.1 >nul",
			")",
			":done",
			...rest.map(({ kind, path: target }) =>
				kind === "file"
					? `del /f /q "${target}" 2>nul`
					: `rmdir /s /q "${target}" 2>nul`,
			),
			// Absent unless the user imported the installer's own .reg file, so
			// this failing is the ordinary case rather than a fault.
			`reg delete "${UNINSTALL_KEY}\\${roots.identifier}" /f >nul 2>nul`,
			// A batch file is read as it runs, so jumping past its end frees the
			// handle and lets the last command remove the file being executed.
			'(goto) 2>nul & del "%~f0"',
			"",
		];
		return lines.join("\r\n");
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
