import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Updater } from "electrobun/bun";
import type { RpcResult } from "../shared/rpcSchema";
import { describeError } from "./BinaryManager";

const EXIT_WAIT_SECONDS = 120;

const READY_TIMEOUT_MS = 8_000;
const READY_POLL_MS = 100;

export interface InstallRoots {
	localAppData: string;
	install: string;
	identifier: string;
	channel: string;
}

interface HelperFiles {
	worker: string;
	launcher: string;
	ready: string;
	log: string;
}

export async function installRoots(): Promise<InstallRoots | null> {
	if (process.platform !== "win32") return null;
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) return null;
	const { identifier, channel } = await Updater.getLocalInfo();
	if (!identifier || !channel) return null;
	if (!/^[A-Za-z0-9._-]+$/.test(identifier)) return null;

	const install = path.join(localAppData, identifier);
	if (!isInside(path.join(install, channel), process.execPath)) return null;
	return { localAppData, install, identifier, channel };
}

export async function launchDetached(
	noun: string,
	root: string,
	body: string[],
	untouched: string,
): Promise<RpcResult> {
	const stem = path.join(
		os.tmpdir(),
		`vexwave-${noun}-${Date.now().toString(36)}`,
	);
	const files: HelperFiles = {
		worker: `${stem}-worker.ps1`,
		launcher: `${stem}-launch.ps1`,
		ready: `${stem}.ready`,
		log: `${stem}.log`,
	};
	try {
		await writeScript(
			files.worker,
			[...preamble(files, root), ...body, "Finish", ""].join("\r\n"),
		);
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
			error: `Couldn't start the ${noun}: ${describeError(err)}`,
		};
	}
	if (await waitForHandshake(files.ready)) return { ok: true };
	await rm(files.worker, { force: true }).catch(() => {});
	return {
		ok: false,
		error: `The ${noun} didn't start, so ${untouched}. Its log is at ${files.log}`,
	};
}

function preamble(files: HelperFiles, root: string): string[] {
	return [
		"$ErrorActionPreference = 'SilentlyContinue'",
		`$log = ${literal(files.log)}`,
		`$ready = ${literal(files.ready)}`,
		`$root = ${literal(root)}`,
		"",
		`function Note($m) { [IO.File]::AppendAllText($log, ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) + [Environment]::NewLine) }`,
		"function Finish { Remove-Item -LiteralPath $ready -Force; Remove-Item -LiteralPath $PSCommandPath -Force; exit }",
		"",
		`Note 'waiting for pid ${process.pid}'`,
		"[IO.File]::WriteAllText($ready, 'ready')",
		"",
		`$deadline = (Get-Date).AddSeconds(${EXIT_WAIT_SECONDS})`,
		`while (Get-Process -Id ${process.pid}) {`,
		"\tif ((Get-Date) -gt $deadline) { Note 'app never exited; nothing done'; Finish }",
		"\tStart-Sleep -Milliseconds 500",
		"}",
		"",
		// CEF keeps BrowserMetrics\*.pma mapped until killed.
		`$running = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($root + '\\', 'OrdinalIgnoreCase') })`,
		"if ($running) {",
		"\tNote ('stopping ' + (($running | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join ', '))",
		"\t$running | Stop-Process -Force",
		"\tStart-Sleep -Seconds 2",
		"}",
		"",
	];
}

function launcher(files: HelperFiles): string {
	return [
		"$ErrorActionPreference = 'SilentlyContinue'",
		"$flags = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File'",
		`$line = $flags + ' "' + ${literal(files.worker)} + '"'`,
		// Without SW_HIDE, WMI gives the helper a console.
		"$startup = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
		"$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe ' + $line; ProcessStartupInformation = $startup }",
		"if (-not $result -or $result.ReturnValue -ne 0) {",
		"\tStart-Process -FilePath 'powershell.exe' -ArgumentList $line -WindowStyle Hidden",
		"}",
		`Remove-Item -LiteralPath ${literal(files.launcher)} -Force`,
		"",
	].join("\r\n");
}

// Without a BOM, Windows PowerShell mangles non-ASCII paths.
function writeScript(target: string, script: string): Promise<void> {
	return writeFile(target, `\uFEFF${script}`, "utf8");
}

// PowerShell also treats ‘ ’ ‚ ‛ as single quotes; doubling escapes each.
export function literal(value: string): string {
	return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
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
