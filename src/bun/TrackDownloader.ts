import path from "node:path";
import { Utils } from "electrobun/bun";
import type { DownloadTrackResult } from "../shared/rpcSchema";
import type { StreamProxy } from "./StreamProxy";
import { sanitizeFileName } from "./UrlImporter";

const MAX_NAME_ATTEMPTS = 100;

// Under Windows' MAX_PATH of 260.
const MAX_PATH_CHARS = 250;

// What macOS and Linux allow a single path component, in bytes not characters.
const MAX_NAME_BYTES = 255;

const SUFFIX_CHARS = " (100)".length;

// ponytail: the picker and the whole file ride one RPC answer, so an open
// dialog or a cold track near the 75 MiB ceiling on a slow link fails as a
// maxRequestTime timeout. Upgrade path is the importFromUrl shape: answer
// immediately and push progress.
export async function saveTrackToDisk(
	streamProxy: StreamProxy,
	trackId: string,
	fileName: string,
	startingFolder?: string,
): Promise<DownloadTrackResult> {
	try {
		const dir = await pickFolder(startingFolder);
		if (!dir) return { ok: true, path: null };

		const response = await fetch(streamProxy.urlForTrack(trackId));
		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				error: `The server refused the download (${response.status}).`,
			};
		}
		const bytes = new Uint8Array(await response.arrayBuffer());

		const extension = extensionOf(bytes);
		const target = await freeName(
			dir,
			fitName(dir, sanitizeFileName(fileName, "Track"), extension),
			extension,
		);
		await Bun.write(target, bytes);
		return { ok: true, path: target, folder: dir };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "The download failed.",
		};
	}
}

function fitName(dir: string, base: string, ext: string): string {
	const charBudget = MAX_PATH_CHARS - dir.length - 1 - SUFFIX_CHARS - ext.length;
	const byteBudget = MAX_NAME_BYTES - SUFFIX_CHARS - Buffer.byteLength(ext);
	let kept = "";
	let bytes = 0;
	for (const char of base) {
		const size = Buffer.byteLength(char);
		if (kept.length + char.length > charBudget || bytes + size > byteBudget) {
			break;
		}
		kept += char;
		bytes += size;
	}
	// Trailing space before the extension is Windows' other quiet refusal.
	return kept.trimEnd() || "Track";
}

async function freeName(
	dir: string,
	base: string,
	ext: string,
): Promise<string> {
	for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
		const name = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
		const candidate = path.join(dir, name);
		if (!(await Bun.file(candidate).exists())) return candidate;
	}
	return path.join(dir, `${base} (${Date.now()})${ext}`);
}

function extensionOf(data: Uint8Array): string {
	const ascii = (start: number, length: number) =>
		String.fromCharCode(...data.subarray(start, start + length));
	if (ascii(0, 3) === "ID3") return ".mp3";
	if (data.length > 1 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) {
		return ".mp3";
	}
	if (ascii(0, 4) === "fLaC") return ".flac";
	if (ascii(0, 4) === "OggS") return ".ogg";
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return ".wav";
	if (ascii(4, 4) === "ftyp") return ".m4a";
	return ".mp3";
}

async function pickFolder(startingFolder?: string): Promise<string | undefined> {
	const [folder] = await Utils.openFileDialog({
		startingFolder: startingFolder || Utils.paths.home,
		canChooseFiles: false,
		canChooseDirectory: true,
		allowsMultipleSelection: false,
	});
	return folder || undefined;
}
