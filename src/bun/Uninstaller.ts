import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Updater } from "electrobun/bun";
import type { RpcResult } from "../shared/rpcSchema";

/** The two shortcuts the Electrobun installer creates, under a known root. */
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
const EXIT_WAIT_SECONDS = 120;

/**
 * How long it then keeps at the install directory. Only a scanner or an open
 * folder window can still hold it: our own processes are stopped by this point.
 */
const DELETE_RETRY_SECONDS = 30;

/** How long to wait for the helper to report itself before giving up on it. */
const READY_TIMEOUT_MS = 8_000;
const READY_POLL_MS = 100;

interface Roots {
	/** `%LOCALAPPDATA%\app.vexwave` — every channel, not just the running one. */
	install: string;
	/** The bare identifier, which also names the registry uninstall key. */
	identifier: string;
}

/** One run's files, off a common stem so its leftovers sort together. */
interface HelperFiles {
	worker: string;
	launcher: string;
	ready: string;
	log: string;
}

/**
 * Removes VexWave from the machine: the install directory, the downloaded
 * binaries beside it, the shortcuts, and the registry entry.
 *
 * Windows holds an executing image open and every VexWave process runs out of
 * the tree being removed, so the work goes to a detached helper. What that
 * helper must get right, all learned the hard way:
 *
 *   - it waits for this process to exit, or it takes only what happens to be
 *     unlocked and leaves a half-removed install;
 *   - it then stops what still runs out of the tree: quitting force-exits and
 *     orphans the CEF helpers, and a file one of them has mapped cannot be
 *     deleted at all;
 *   - it starts through WMI, outside this process's tree, so whatever reaps the
 *     app's children can't reap it too;
 *   - it reports for duty before this side quits, or the app closes on a
 *     removal that never runs.
 */
export class Uninstaller {
	/**
	 * @param componentsDir The binaries' own directory, or null where the
	 * platform has none. Its *parent* is what goes: `imports/` is a sibling
	 * (`UrlImporter`), and both are ours.
	 */
	constructor(private readonly componentsDir: string | null) {}

	/** Whether there is an install here this copy may remove. */
	async removable(): Promise<boolean> {
		return (await this.resolveRoots()) !== null;
	}

	/**
	 * Writes the helper and answers once it has confirmed it is waiting. The
	 * caller quits on success, which is the signal the helper waits for; on
	 * failure nothing has been touched.
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

		const leftovers = [
			...(this.componentsDir ? [path.dirname(this.componentsDir)] : []),
			...(await strandedShortcuts(roots.install)),
		];

		const stem = path.join(
			os.tmpdir(),
			`vexwave-uninstall-${Date.now().toString(36)}`,
		);
		const files: HelperFiles = {
			worker: `${stem}-worker.ps1`,
			launcher: `${stem}-launch.ps1`,
			ready: `${stem}.ready`,
			log: `${stem}.log`,
		};

		try {
			await writeScript(files.worker, worker(roots, leftovers, files));
			await writeScript(files.launcher, launcher(files));
			Bun.spawn(
				[
					"powershell.exe",
					"-NoProfile",
					"-NonInteractive",
					"-WindowStyle",
					"Hidden",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					files.launcher,
				],
				// Without this a console window flashes up: the app has none of its
				// own for a child to inherit.
				{ stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
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

		if (!(await waitForHandshake(files.ready))) {
			// Quitting now would close the app on a removal that never runs.
			await rm(files.worker, { force: true }).catch(() => {});
			return {
				ok: false,
				error: `The uninstaller didn't start, so nothing was removed. Its log is at ${files.log}`,
			};
		}
		return { ok: true };
	}

	/**
	 * `%LOCALAPPDATA%\<identifier>`, or null when this copy has no business
	 * deleting it. `getLocalInfo` answers with empty strings when it can't read
	 * `version.json`, and joining those lands on `%LOCALAPPDATA%` itself — so the
	 * running executable has to be found inside the channel folder before the
	 * tree counts as ours. That is also what makes a dev build refuse.
	 */
	private async resolveRoots(): Promise<Roots | null> {
		if (process.platform !== "win32") return null;
		const localAppData = process.env.LOCALAPPDATA;
		if (!localAppData) return null;
		const { identifier, channel } = await Updater.getLocalInfo();
		if (!identifier || !channel) return null;
		// The identifier also names a registry key, so nothing but a plain name.
		if (!/^[A-Za-z0-9._-]+$/.test(identifier)) return null;

		const install = path.join(localAppData, identifier);
		if (!isInside(path.join(install, channel), process.execPath)) return null;
		return { install, identifier };
	}
}

/** The helper. It logs every branch: nothing is left to report a failure to. */
function worker(roots: Roots, leftovers: string[], files: HelperFiles): string {
	return [
		"$ErrorActionPreference = 'SilentlyContinue'",
		`$log = ${literal(files.log)}`,
		`$ready = ${literal(files.ready)}`,
		`$install = ${literal(roots.install)}`,
		`$exe = ${literal(process.execPath)}`,
		"",
		// Not `Out-File -Encoding utf8`: it stamps a byte-order mark mid-log.
		`function Note($m) { [IO.File]::AppendAllText($log, ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) + [Environment]::NewLine) }`,
		// A script is read into memory before it runs, so it can remove itself.
		"function Finish { Remove-Item -LiteralPath $ready -Force; Remove-Item -LiteralPath $PSCommandPath -Force; exit }",
		"",
		`Note 'waiting for pid ${process.pid}'`,
		// The handshake: until this exists, the app must not quit.
		"[IO.File]::WriteAllText($ready, 'ready')",
		"",
		`$deadline = (Get-Date).AddSeconds(${EXIT_WAIT_SECONDS})`,
		`while (Get-Process -Id ${process.pid}) {`,
		"\tif ((Get-Date) -gt $deadline) { Note 'app never exited; nothing removed'; Finish }",
		"\tStart-Sleep -Milliseconds 500",
		"}",
		"",
		// Quitting force-exits, orphaning the CEF helpers, and one of those keeps
		// CEF\BrowserMetrics\*.pma mapped. A mapped file cannot be deleted at all,
		// so there is nothing here to wait out.
		`$running = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($install + '\\', 'OrdinalIgnoreCase') })`,
		"if ($running) {",
		"\tNote ('stopping ' + (($running | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join ', '))",
		"\t$running | Stop-Process -Force",
		"\tStart-Sleep -Seconds 2",
		"}",
		"",
		`$deadline = (Get-Date).AddSeconds(${DELETE_RETRY_SECONDS})`,
		"while ($true) {",
		"\tRemove-Item -LiteralPath $install -Recurse -Force",
		"\tif (-not (Test-Path -LiteralPath $install)) { break }",
		"\tif ((Get-Date) -gt $deadline) { break }",
		"\tStart-Sleep -Seconds 1",
		"}",
		"",
		"if (Test-Path -LiteralPath $install) {",
		// A removal that never started, told from one that finished around
		// something it couldn't take. Only the first is worth leaving alone:
		// shortcuts into a gutted install point nowhere.
		"\tif (Test-Path -LiteralPath $exe) { Note 'install directory would not go; nothing else touched'; Finish }",
		"\tNote 'install directory left a remnant; removing the rest anyway'",
		"} else {",
		"\tNote 'install directory removed'",
		"}",
		"",
		// `-Recurse`: needed by a directory, ignored by a file.
		...leftovers.map(
			(target) => `Remove-Item -LiteralPath ${literal(target)} -Recurse -Force`,
		),
		// Absent unless the installer's own .reg file was imported, so failing
		// here is the ordinary case.
		`Remove-Item -LiteralPath ${literal(`${UNINSTALL_KEY}\\${roots.identifier}`)} -Recurse -Force`,
		"Note 'done'",
		"Finish",
		"",
	].join("\r\n");
}

/**
 * Hands the worker to WMI, whose service creates it: a process started from
 * here would belong to this app's tree and die with it. `Start-Process` is the
 * fallback where WMI won't answer, and the caller finds out either way from the
 * handshake.
 */
function launcher(files: HelperFiles): string {
	return [
		"$ErrorActionPreference = 'SilentlyContinue'",
		"$flags = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File'",
		// Neither route below quotes for us, and the temp path can hold spaces. A
		// `"` is not legal in a Windows path, so nothing escapes this.
		`$line = $flags + ' "' + ${literal(files.worker)} + '"'`,
		// SW_HIDE. Without it WMI gives the helper a console of its own; the flags
		// above only cover PowerShell's host window.
		"$startup = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
		"$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe ' + $line; ProcessStartupInformation = $startup }",
		"if (-not $result -or $result.ReturnValue -ne 0) {",
		"\tStart-Process -FilePath 'powershell.exe' -ArgumentList $line -WindowStyle Hidden",
		"}",
		`Remove-Item -LiteralPath ${literal(files.launcher)} -Force`,
		"",
	].join("\r\n");
}

/**
 * Windows PowerShell reads a script with no byte-order mark in the system
 * codepage, where a UTF-8 path turns to mojibake and matches nothing: without
 * this, a user name outside ASCII makes the whole removal quietly do none of it.
 */
function writeScript(target: string, script: string): Promise<void> {
	return writeFile(target, `\uFEFF${script}`, "utf8");
}

/**
 * A PowerShell single-quoted literal. Doubling the quote is its whole escaping,
 * and paths do hold one: `C:\Users\O'Brien`.
 */
function literal(value: string): string {
	return `'${value.split("'").join("''")}'`;
}

/**
 * Shortcuts that would be left pointing at nothing. A `.lnk` holds its target
 * inside itself, so one is claimed only when the install path appears in its
 * bytes, in either encoding — matching on the filename would take a shortcut
 * someone made for something else. A redirected Desktop keeps its icon: hunting
 * shell folders costs more than a dead one.
 */
async function strandedShortcuts(install: string): Promise<string[]> {
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

/** Polls for the file the helper writes to say it is alive and waiting. */
async function waitForHandshake(ready: string): Promise<boolean> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await Bun.file(ready).exists()) return true;
		await Bun.sleep(READY_POLL_MS);
	}
	return false;
}

/** Whether `child` lies within `parent`, both compared as resolved paths. */
function isInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return (
		relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	);
}
