import path from "node:path";
import type { RpcResult } from "../shared/rpcSchema";
import {
	type InstallRoots,
	installRoots,
	launchDetached,
	literal,
} from "./detachedHelper";

const SHORTCUTS: { root: string | undefined; segments: string[] }[] = [
	{
		root: process.env.APPDATA,
		segments: ["Microsoft", "Windows", "Start Menu", "Programs", "VexWave.lnk"],
	},
	{ root: process.env.USERPROFILE, segments: ["Desktop", "VexWave.lnk"] },
];

const UNINSTALL_KEY =
	"HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

const DELETE_RETRY_SECONDS = 30;

export class Uninstaller {
	constructor(private readonly componentsDir: string | null) {}

	async removable(): Promise<boolean> {
		return (await installRoots()) !== null;
	}

	async start(): Promise<RpcResult> {
		const roots = await installRoots();
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

		return launchDetached(
			"uninstaller",
			roots.install,
			worker(roots, leftovers),
			"nothing was removed",
		);
	}
}

function worker(roots: InstallRoots, leftovers: string[]): string[] {
	return [
		`$exe = ${literal(process.execPath)}`,
		`$deadline = (Get-Date).AddSeconds(${DELETE_RETRY_SECONDS})`,
		"while ($true) {",
		"\tRemove-Item -LiteralPath $root -Recurse -Force",
		"\tif (-not (Test-Path -LiteralPath $root)) { break }",
		"\tif ((Get-Date) -gt $deadline) { break }",
		"\tStart-Sleep -Seconds 1",
		"}",
		"",
		"if (Test-Path -LiteralPath $root) {",
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
	];
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
