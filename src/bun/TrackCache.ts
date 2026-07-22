/** A fully-downloaded track's audio, kept in memory for instant replays. */
export interface CachedTrack {
	// The explicit backing-buffer type keeps `bytes` (and its subarray views)
	// assignable to Response's BodyInit, which rejects SharedArrayBuffer views.
	bytes: Uint8Array<ArrayBuffer>;
	contentType: string;
}

/**
 * Byte-bounded LRU over complete track payloads. Only whole files are ever
 * stored (partial downloads are useless for Range serving), so a hit can
 * answer any Range request without touching the backend. Map iteration order
 * doubles as the recency order: `get` re-inserts the entry, so the first key
 * is always the least recently used.
 */
export class TrackCache {
	private readonly entries = new Map<number, CachedTrack>();
	private totalBytes = 0;

	constructor(private readonly maxBytes: number) {}

	/** Whether a payload of this size is admissible at all. */
	fits(byteLength: number): boolean {
		return byteLength <= this.maxBytes;
	}

	/** Ids of every fully-cached track. */
	ids(): number[] {
		return [...this.entries.keys()];
	}

	get(trackId: number): CachedTrack | undefined {
		const entry = this.entries.get(trackId);
		if (entry) {
			this.entries.delete(trackId);
			this.entries.set(trackId, entry);
		}
		return entry;
	}

	set(trackId: number, entry: CachedTrack): void {
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

	/** Returns whether the entry existed (i.e. membership actually changed). */
	delete(trackId: number): boolean {
		const entry = this.entries.get(trackId);
		if (!entry) return false;
		this.entries.delete(trackId);
		this.totalBytes -= entry.bytes.byteLength;
		return true;
	}

	/** Returns whether anything was dropped (i.e. membership actually changed). */
	clear(): boolean {
		const hadEntries = this.entries.size > 0;
		this.entries.clear();
		this.totalBytes = 0;
		return hadEntries;
	}
}

/**
 * Serves a cached track the way the backend would: 206 + content-range for a
 * satisfiable Range, 416 for an out-of-bounds one, plain 200 otherwise.
 * Multi-part ranges fall back to the full body (a valid answer per RFC 9110;
 * Chromium's media loader only ever sends single ranges anyway). Unlike the
 * proxied path, content-length is safe here — the bytes are complete and
 * local, so the declared length can't mismatch what gets delivered.
 */
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

/** null → ignore the header and serve the full body. */
function parseRange(
	header: string,
	size: number,
): { start: number; end: number } | "unsatisfiable" | null {
	const match = header.match(/^bytes=(\d*)-(\d*)$/);
	if (!match || (match[1] === "" && match[2] === "")) return null;
	if (match[1] === "") {
		// Suffix form: last N bytes.
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
