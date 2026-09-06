import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Utils } from "electrobun/bun";
import type { DownloadTrackResult } from "../shared/rpcSchema";
import type { StreamProxy } from "./StreamProxy";
import { sanitizeFileName } from "./UrlImporter";

/**
 * Keeping a copy of a track on the machine — the one direction in which server
 * audio leaves the app.
 */

/** How many `(n)` suffixes to try before giving up on an unused name. */
const MAX_NAME_ATTEMPTS = 100;

/**
 * Longest path to build, under Windows' MAX_PATH of 260. A title is capped at
 * 200 characters and a track may credit 64 artists, so `Artist - Title` runs
 * past this on its own; the folder and the extension eat into it further.
 */
const MAX_PATH_CHARS = 250;

/**
 * What macOS and Linux allow a single path component, in bytes rather than
 * characters — 200 characters of CJK is 600 of them, so the two limits bite in
 * different places and a name has to clear both.
 */
const MAX_NAME_BYTES = 255;

/** Room left for the ` (2)` a collision appends, up to `MAX_NAME_ATTEMPTS`. */
const SUFFIX_CHARS = " (100)".length;

/**
 * Writes a track into the user's Downloads folder and answers with where it
 * landed.
 *
 * The bytes come from the proxy's own loopback URL rather than a second
 * backend fetch, so a track that is playing or was played is already in
 * `TrackCache`, and one that isn't gets teed into it on the way past.
 *
 * ponytail: the whole file rides one RPC answer, so a cold track near the
 * 75 MiB ceiling fails as a `maxRequestTime` timeout on a slow link. Upgrade
 * path if that ever bites is the `importFromUrl` shape: answer immediately and
 * push progress.
 */
export async function saveTrackToDownloads(
	streamProxy: StreamProxy,
	trackId: string,
	fileName: string,
): Promise<DownloadTrackResult> {
	try {
		const response = await fetch(streamProxy.urlForTrack(trackId));
		if (!response.ok) {
			// A 401 has already gone out as `sessionExpired` from the proxy.
			return {
				ok: false,
				status: response.status,
				error: `The server refused the download (${response.status}).`,
			};
		}
		const bytes = new Uint8Array(await response.arrayBuffer());

		const dir = Utils.paths.downloads;
		await mkdir(dir, { recursive: true });
		const extension = extensionOf(bytes);
		const target = await freeName(
			dir,
			fitName(dir, sanitizeFileName(fileName, "Track"), extension),
			extension,
		);
		await Bun.write(target, bytes);
		return { ok: true, path: target };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "The download failed.",
		};
	}
}

/**
 * The name cut down to what both limits leave room for. Nothing else guards
 * the length: the contract bounds a title and an artist name at 200 characters
 * each and says nothing about how many artists a credit line joins, so a name
 * arrives long enough to be refused by the filesystem rather than by the
 * server.
 *
 * Cut by code point, so neither budget can land inside a surrogate pair and
 * leave half an emoji in the name.
 */
function fitName(dir: string, base: string, ext: string): string {
	// The separator `path.join` adds counts against the path too.
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

/**
 * The first `<base><ext>`, `<base> (2)<ext>`, … nothing occupies. Downloading
 * the same track twice is a copy, not a replacement: the folder is the user's,
 * and nothing here may overwrite a file it didn't write.
 */
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
	// Past that many namesakes, a timestamp beats another hundred stat calls.
	return path.join(dir, `${base} (${Date.now()})${ext}`);
}

/**
 * The container the bytes are in. The contract declares every audio response
 * `application/octet-stream` and carries no filename, so the extension can only
 * come from the bytes — same sniff the test server does to pick a MIME.
 */
function extensionOf(data: Uint8Array): string {
	const ascii = (start: number, length: number) =>
		String.fromCharCode(...data.subarray(start, start + length));
	if (ascii(0, 3) === "ID3") return ".mp3";
	if (data.length > 1 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) {
		return ".mp3"; // raw MPEG frame sync
	}
	if (ascii(0, 4) === "fLaC") return ".flac";
	if (ascii(0, 4) === "OggS") return ".ogg";
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return ".wav";
	if (ascii(4, 4) === "ftyp") return ".m4a";
	// Uploads are audio/* or mp4, and mp3 is what the importer produces.
	return ".mp3";
}
