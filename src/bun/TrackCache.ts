export interface CachedTrack {
	bytes: Uint8Array<ArrayBuffer>;
	contentType: string;
}

export class TrackCache {
	private readonly entries = new Map<string, CachedTrack>();
	private totalBytes = 0;

	constructor(private readonly maxBytes: number) {}

	fits(byteLength: number): boolean {
		return byteLength <= this.maxBytes;
	}

	get(trackId: string): CachedTrack | undefined {
		const entry = this.entries.get(trackId);
		if (entry) {
			this.entries.delete(trackId);
			this.entries.set(trackId, entry);
		}
		return entry;
	}

	set(trackId: string, entry: CachedTrack): void {
		if (!this.fits(entry.bytes.byteLength)) return;
		this.delete(trackId);
		while (this.totalBytes + entry.bytes.byteLength > this.maxBytes) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.delete(oldest.value);
		}
		this.entries.set(trackId, entry);
		this.totalBytes += entry.bytes.byteLength;
	}

	delete(trackId: string): void {
		const entry = this.entries.get(trackId);
		if (!entry) return;
		this.entries.delete(trackId);
		this.totalBytes -= entry.bytes.byteLength;
	}

	clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
	}
}

// Multi-part ranges fall back to the full body: a valid answer per RFC 9110,
// and Chromium's media loader only ever sends single ranges.
export function respondFromCache(
	entry: CachedTrack,
	rangeHeader: string | null,
): Response {
	const size = entry.bytes.byteLength;
	const baseHeaders = {
		"content-type": entry.contentType,
		"accept-ranges": "bytes",
	};
	const range = rangeHeader === null ? null : parseRange(rangeHeader, size);
	if (range === null) {
		return new Response(entry.bytes, { headers: baseHeaders });
	}
	if (range === "unsatisfiable") {
		return new Response(null, {
			status: 416,
			headers: { ...baseHeaders, "content-range": `bytes */${size}` },
		});
	}
	return new Response(entry.bytes.subarray(range.start, range.end + 1), {
		status: 206,
		headers: {
			...baseHeaders,
			"content-range": `bytes ${range.start}-${range.end}/${size}`,
		},
	});
}

function parseRange(
	header: string,
	size: number,
): { start: number; end: number } | "unsatisfiable" | null {
	const match = header.match(/^bytes=(\d*)-(\d*)$/);
	if (!match || (match[1] === "" && match[2] === "")) return null;
	if (match[1] === "") {
		const suffixLength = Number(match[2]);
		if (suffixLength === 0) return "unsatisfiable";
		return { start: Math.max(0, size - suffixLength), end: size - 1 };
	}
	const start = Number(match[1]);
	if (start >= size) return "unsatisfiable";
	const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	if (start > end) return "unsatisfiable";
	return { start, end };
}
