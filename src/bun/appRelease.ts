export const RELEASES_LATEST_API =
	"https://api.github.com/repos/VexWave/vex-app/releases/latest";

const INSTALLER_ASSET = "VexWave-Setup.exe";

export interface InstallerRelease {
	version: string;
	url: string;
	size: number | undefined;
	sha256: string | undefined;
}

interface GitHubRelease {
	tag_name?: unknown;
	assets?: unknown;
}

interface GitHubAsset {
	name?: unknown;
	browser_download_url?: unknown;
	size?: unknown;
	digest?: unknown;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(value: string): [number, number, number] | null {
	const match = VERSION.exec(value.trim());
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewer(candidate: string, current: string): boolean {
	const a = parseVersion(candidate);
	const b = parseVersion(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i]! > b[i]!;
	}
	return false;
}

export function pickInstaller(release: unknown): InstallerRelease | null {
	if (!release || typeof release !== "object") return null;
	const { tag_name, assets } = release as GitHubRelease;
	if (typeof tag_name !== "string" || !parseVersion(tag_name)) return null;
	if (!Array.isArray(assets)) return null;
	const asset = (assets as GitHubAsset[]).find(
		(entry) => entry?.name === INSTALLER_ASSET,
	);
	if (!asset || typeof asset.browser_download_url !== "string") return null;
	const digest =
		typeof asset.digest === "string"
			? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)
			: null;
	return {
		version: tag_name.replace(/^v/, ""),
		url: asset.browser_download_url,
		size:
			typeof asset.size === "number" && asset.size > 0 ? asset.size : undefined,
		sha256: digest ? digest[1]!.toLowerCase() : undefined,
	};
}
