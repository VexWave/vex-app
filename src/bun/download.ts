import { rm } from "node:fs/promises";

const PROGRESS_INTERVAL_MS = 150;

export async function fetchLatestRelease(
	api: string,
	proxy: string | undefined,
): Promise<unknown> {
	const res = await fetch(api, {
		headers: { Accept: "application/vnd.github+json" },
		proxy,
	});
	return res.ok ? res.json() : null;
}

export async function downloadToFile(
	url: string,
	target: string,
	options: {
		proxy: string | undefined;
		onProgress: (receivedBytes: number, totalBytes: number | undefined) => void;
		onChunk?: (chunk: Uint8Array) => void;
	},
): Promise<number> {
	const res = await fetch(url, { proxy: options.proxy });
	if (!res.ok || !res.body) {
		throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
	}
	const contentLength = Number(res.headers.get("content-length"));
	const totalBytes =
		Number.isFinite(contentLength) && contentLength > 0
			? contentLength
			: undefined;

	// The writer doesn't truncate.
	await rm(target, { force: true });
	const sink = Bun.file(target).writer();
	let receivedBytes = 0;
	let lastEmit = 0;
	try {
		options.onProgress(receivedBytes, totalBytes);
		const reader = res.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			receivedBytes += value.byteLength;
			options.onChunk?.(value);
			sink.write(value);
			const now = Date.now();
			if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
				lastEmit = now;
				options.onProgress(receivedBytes, totalBytes);
				await sink.flush();
			}
		}
		options.onProgress(receivedBytes, totalBytes);
	} finally {
		await sink.end();
	}
	return receivedBytes;
}
