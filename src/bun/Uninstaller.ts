import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Updater } from "electrobun/bun";
import type { RpcResult } from "../shared/rpcSchema";

const SHORTCUTS: { root: string | undefined; segments: string[] }[] = [
	{
		root: process.env.APPDATA,
		segments: ["Microsoft", "Windows", "Start Menu", "Programs", "VexWave.lnk"],
	},
	{ root: process.env.USERPROFILE, segments: ["Desktop", "VexWave.lnk"] },
];

const UNINSTALL_KEY =
	"HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

const EXIT_WAIT_SECONDS = 120;

const DELETE_RETRY_SECONDS = 30;

const READY_TIMEOUT_MS = 8_000;
const READY_POLL_MS = 100;

interface Roots {
	install: string;
	identifier: string;
}

interface HelperFiles {
	worker: string;
	launcher: string;
	ready: string;
	log: string;
}

// Windows holds an executing image open and every VexWave process runs out of
// the tree being removed, so the work goes to a detached helper.
export class Uninstaller {
	constructor(private readonly componentsDir: string | null) {}

	async removable(): Promise<boolean> {
		return (await this.resolveRoots()) !== null;
	}

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
			await rm(files.worker, { force: true }).catch(() => {});
			return {
				ok: false,
				error: `The uninstaller didn't start, so nothing was removed. Its log is at ${files.log}`,
			};
		}
		return { ok: true };
	}

	private async resolveRoots(): Promise<Roots | null> {
		if (process.platform !== "win32") return null;
		const localAppData = process.env.LOCALAPPDATA;
		if (!localAppData) return null;
		const { identifier, channel } = await Updater.getLocalInfo();
		if (!identifier || !channel) return null;
		if (!/^[A-Za-z0-9._-]+$/.test(identifier)) return null;

		const install = path.join(localAppData, identifier);
		if (!isInside(path.join(install, channel), process.execPath)) return null;
		return { install, identifier };
	}
}

function worker(roots: Roots, leftovers: string[], files: HelperFiles): string {
	return [
		"$ErrorActionPreference = 'SilentlyContinue'",
		`$log = ${literal(files.log)}`,
		`$ready = ${literal(files.ready)}`,
		`$install = ${literal(roots.install)}`,
		`$exe = ${literal(process.execPath)}`,
		"",
		`function Note($m) { [IO.File]::AppendAllText($log, ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) + [Environment]::NewLine) }`,
		"function Finish { Remove-Item -LiteralPath $ready -Force; Remove-Item -LiteralPath $PSCommandPath -Force; exit }",
		"",
		`Note 'waiting for pid ${process.pid}'`,
		"[IO.File]::WriteAllText($ready, 'ready')",
		"",
		`$deadline = (Get-Date).AddSeconds(${EXIT_WAIT_SECONDS})`,
		`while (Get-Process -Id ${process.pid}) {`,
		"\tif ((Get-Date) -gt $deadline) { Note 'app never exited; nothing removed'; Finish }",
		"\tStart-Sleep -Milliseconds 500",
		"}",
		"",
		// A CEF helper keeps CEF\BrowserMetrics\*.pma mapped, and a mapped file
		// cannot be deleted at all, so there is nothing here to wait out.
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
		"\tif (Test-Path -LiteralPath $exe) { Note 'install directory would not go; nothing else touched'; Finish }",
		"\tNote 'install directory left a remnant; removing the rest anyway'",
		"} else {",
		"\tNote 'install directory removed'",
		"}",
		"",
		...leftovers.map(
			(target) => `Remove-Item -LiteralPath ${literal(target)} -Recurse -Force`,
		),
		`Remove-Item -LiteralPath ${literal(`${UNINSTALL_KEY}\\${roots.identifier}`)} -Recurse -Force`,
		"Note 'done'",
		"Finish",
		"",
	].join("\r\n");
}

function launcher(files: HelperFiles): string {
	return [
		"$ErrorActionPreference = 'SilentlyContinue'",
		"$flags = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File'",
		`$line = $flags + ' "' + ${literal(files.worker)} + '"'`,
		// SW_HIDE: without it WMI gives the helper a console of its own.
		"$startup = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
		"$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe ' + $line; ProcessStartupInformation = $startup }",
		"if (-not $result -or $result.ReturnValue -ne 0) {",
		"\tStart-Process -FilePath 'powershell.exe' -ArgumentList $line -WindowStyle Hidden",
		"}",
		`Remove-Item -LiteralPath ${literal(files.launcher)} -Force`,
		"",
	].join("\r\n");
}

// Windows PowerShell reads a BOM-less script in the system codepage, where a
// non-ASCII path turns to mojibake and matches nothing.
function writeScript(target: string, script: string): Promise<void> {
	return writeFile(target, `\uFEFF${script}`, "utf8");
}

// PowerShell single-quoted literal; doubling the quote is its whole escaping.
function literal(value: string): string {
	return `'${value.split("'").join("''")}'`;
}

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

async function waitForHandshake(ready: string): Promise<boolean> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await Bun.file(ready).exists()) return true;
		await Bun.sleep(READY_POLL_MS);
	}
	return false;
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return (
		relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	);
}
