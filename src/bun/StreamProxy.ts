import {
	artistImagePath,
	playlistImagePath,
	trackAudioPath,
	trackImagePath,
} from "../../contract/contract";
import type { ApiClient } from "./ApiClient";
import { imageVersion, versionQuery } from "./imageVersion";
import { TrackCache, respondFromCache } from "./TrackCache";

/**
 * Response headers forwarded verbatim from the backend to the audio element.
 * content-length is deliberately NOT forwarded: the body is a piped stream,
 * so a declared length could mismatch the delivered bytes if the upstream
 * connection drops mid-transfer. Playback doesn't need it — Chromium's media
 * loader opens with `Range: bytes=0-`, so the total size reaches it via the
 * content-range header of the resulting 206.
 */
const PASSTHROUGH_HEADERS = [
	"content-type",
	"content-range",
	"accept-ranges",
] as const;

/**
 * An image also gets the validator it can revalidate with, which turns a
 * re-fetch of a cover the webview still holds into a bodiless 304. Audio does
 * not: whole tracks already sit in this proxy's LRU, and a bare validator is
 * enough for Chromium to keep a second copy to revalidate against.
 */
const IMAGE_HEADERS = [...PASSTHROUGH_HEADERS, "etag"] as const;

/**
 * An image whose URL pinned a version also gets the backend's answer about how
 * long the bytes may be reused, because only then does that answer belong to
 * this URL: the version names the bytes, an edit publishes new ones under a new
 * URL, and the old one is simply never asked for again.
 *
 * An unpinned image is answered `no-cache` by this proxy instead, whatever the
 * backend said. The version in the URL is the whole of how a replaced image
 * reaches the webview, so on a URL carrying none there is nothing left to
 * invalidate a stale copy with: a server that promised a lifetime there would
 * put an edited image out of reach for exactly that long. The validator goes
 * out either way, so an unpinned image revalidates rather than re-transferring.
 */
const PINNED_IMAGE_HEADERS = [...IMAGE_HEADERS, "cache-control"] as const;

/** Upper bound for cached audio; LRU eviction keeps the total under this. */
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

/** A live session, as much of one as forwarding a request needs. */
type Auth = { baseUrl: string; token: string };

/** What a payload is called when the backend named no type for it. */
const NEUTRAL_TYPE = "application/octet-stream";
const contentTypeOf = (response: Response): string =>
	response.headers.get("content-type") ?? NEUTRAL_TYPE;

/**
 * How much of a track the `/head` route serves. A byte bound, so it buys very
 * different amounts of audio per format — some 40 s of a 320 kbps mp3 against a
 * handful of seconds of lossless. It is where the largest decode the webview can
 * land in memory and the shortest window it can leave to measure are both
 * tolerable (`mainview/player/programLevel`).
 */
const HEAD_BYTES = 1_500_000;

/**
 * How long an expected download is waited for before its head is fetched
 * outright. The scan usually rides the same `loadstart` as the element's request,
 * so it only has to outlast the two being scheduled; a request that turns out not
 * to be shareable abandons the expectation rather than leaving it here
 * (`teeIntoCache`). What is left on the full wait is a scan with no request coming
 * at all — the drive raised part-way through a track already past this proxy.
 */
const HEAD_WAIT_MS = 2000;

/** A track's first bytes, and what the backend called them. */
type Head = { bytes: Uint8Array<ArrayBuffer>; contentType: string };

/**
 * One download of a track's bytes, and everything wanting them before it ends:
 * the element streams it, `TrackCache` is filled from it, and the level scan
 * takes its head off it while the rest is still arriving.
 *
 * It can exist before the download does. A `/head` arriving ahead of the
 * element's request creates one unstarted, so the request that does the
 * downloading has something to fill rather than something to announce itself to.
 */
class TrackDownload {
	/** The first `HEAD_BYTES`; null once nothing is going to deliver them. */
	readonly head: Promise<Head | null>;
	/** The head's resolver while it is unsettled, and null once it has been. */
	private settle: ((head: Head | null) => void) | null = null;
	/** Bytes are flowing. Until then this is only an expectation of them. */
	started = false;

	constructor() {
		this.head = new Promise((resolve) => {
			this.settle = resolve;
		});
	}

	/** Nothing is coming: whatever waits on the head stops waiting. */
	abandon(): void {
		this.deliver(null);
	}

	/** Idempotent, so every way out of `drain` can end on the same line. */
	private deliver(head: Head | null): void {
		this.settle?.(head);
		this.settle = null;
	}

	/**
	 * Drains the cache branch of a teed response, releasing the head as soon as it
	 * is complete rather than at the end — the rest of the file is no part of that
	 * answer.
	 *
	 * Returns the whole file, or null if it did not arrive whole. The byte count is
	 * checked against the declared total so a dropped upstream connection (which
	 * can surface as a clean EOF) can never cache a truncated file.
	 */
	async drain(
		stream: ReadableStream<Uint8Array<ArrayBuffer>>,
		contentType: string,
		expectedBytes: number,
	): Promise<Uint8Array<ArrayBuffer> | null> {
		this.started = true;
		// Sized from the declared total and written into as chunks land, so a track
		// is held once rather than as a chunk list and again as the joined buffer.
		const bytes = new Uint8Array(expectedBytes);
		const reader = stream.getReader();
		let received = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (received + value.byteLength > expectedBytes) {
					await reader.cancel();
					return null;
				}
				bytes.set(value, received);
				received += value.byteLength;
				if (this.settle && received >= HEAD_BYTES) {
					this.deliver({ bytes: bytes.slice(0, HEAD_BYTES), contentType });
				}
			}
			// A file that ended before the ceiling — a short track, or a connection
			// that dropped — is its own head, and decodes as a truncated body does.
			if (this.settle && received > 0) {
				this.deliver({ bytes: bytes.slice(0, received), contentType });
			}
			return received === expectedBytes ? bytes : null;
		} catch {
			// Upstream died mid-download; the partial bytes are useless.
			return null;
		} finally {
			this.deliver(null);
		}
	}
}

/**
 * Loopback HTTP server that lets the webview load backend binary payloads it
 * can't reach itself (no CORS, and the session token never enters the webview).
 * The webview requests http://127.0.0.1:<port>/… URLs; this proxy forwards each
 * to the matching backend route with the token attached and pipes the response
 * body straight through. Three kinds of payload go through it:
 *
 * - Track audio: streamed progressively into the audio element — playback
 *   starts as soon as the browser has buffered enough while the rest keeps
 *   downloading. `Range` headers pass through both ways, which is what makes
 *   seeking into not-yet-downloaded regions instant (Chromium re-requests from
 *   the offset). A 401 here means the token died; `onUnauthorized` propagates
 *   that (this round-trip doesn't go through an RPC request, so the caller
 *   can't see the status otherwise). Whole-file responses are additionally
 *   teed into an in-memory LRU: once a track has fully arrived, replays and
 *   seeks are answered from RAM without touching the backend. The tee's cache
 *   branch keeps reading even if the audio element aborts (skip to the next
 *   track), so an in-flight download still completes and lands in the cache.
 *   The element is not the only consumer: the webview reads a track's head to
 *   measure how loud it is before driving it (`mainview/player/programLevel`),
 *   over the sibling route `/head`, answered off the same `TrackDownload` the
 *   element's request is filling.
 * - Artist avatars: fetched by <img> tags. The backend's image route is public,
 *   but the webview still can't address the backend directly, so it goes
 *   through the same proxy.
 * - Finished URL imports: local temp mp3s produced bun-side by the UrlImporter.
 *   No backend involved — the webview fetches the file to stage it through the
 *   regular upload-review flow, so this route needs no session.
 *
 * The server binds only the loopback interface, and the random path secret
 * keeps other local processes from guessing proxy URLs.
 */
export class StreamProxy {
	private server: ReturnType<typeof Bun.serve> | null = null;
	private readonly secret = crypto.randomUUID();
	private readonly cache = new TrackCache(MAX_CACHE_BYTES);
	/**
	 * Downloads worth sharing, by track id, for as long as one is running or
	 * expected. Membership is also what keeps the same id from being teed twice.
	 */
	private readonly downloads = new Map<string, TrackDownload>();
	/**
	 * Session identity the cache was filled under. Track ids are only meaningful
	 * per server+login, so any auth change wipes the cache (and invalidates
	 * in-flight downloads via the key snapshot they carry).
	 */
	private authKey: string | null = null;

	constructor(
		private readonly api: ApiClient,
		private readonly onUnauthorized?: () => void,
		/** importId → local file path, or null when unknown/already discarded. */
		private readonly resolveImportFile?: (importId: string) => string | null,
	) {}

	/** The loopback server, started on first use. */
	private ensureServer(): NonNullable<typeof this.server> {
		if (!this.server) {
			this.server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0, // any free port
				// Chromium pauses media downloads once its buffer is full; keep
				// those idle connections alive as long as Bun allows.
				idleTimeout: 255,
				fetch: (req) => this.handle(req),
			});
		}
		return this.server;
	}

	/**
	 * Loopback URL for one of this proxy's own routes. The port is settled by
	 * starting the server, and the secret prefix is what keeps other local
	 * processes from guessing these URLs, so nothing builds one by hand.
	 */
	private urlFor(path: string): string {
		const { port } = this.ensureServer();
		return `http://127.0.0.1:${port}/${this.secret}${path}`;
	}

	/** Stable stream URL for a server track. */
	urlForTrack(trackId: string): string {
		return this.urlFor(`/track/${trackId}`);
	}

	/**
	 * Avatar URL for a server artist, pinned to the content version the listing
	 * named. The backend answers a pinned request from memory and marks those
	 * bytes cacheable indefinitely, so within a run an avatar is fetched once
	 * per version rather than once per use; replacing it publishes a new URL,
	 * which is what makes the change show through without anything having to
	 * invalidate the old one. Unversioned (a listing that carried no hash) still
	 * works, at the cost of a full backend read every time.
	 *
	 * Only within a run: the port and the secret are both new on every start, so
	 * no proxy URL — and hence nothing the webview cached under one — outlives
	 * the process that handed it out.
	 */
	urlForArtistImage(artistId: number, version?: string): string {
		return this.urlFor(`/artist/${artistId}/image${versionQuery(version)}`);
	}

	/** Cover-image URL for a server track. Versioned as `urlForArtistImage`. */
	urlForTrackImage(trackId: string, version?: string): string {
		return this.urlFor(`/track/${trackId}/image${versionQuery(version)}`);
	}

	/** Cover-image URL for a server playlist. Versioned as `urlForArtistImage`. */
	urlForPlaylistImage(playlistId: number, version?: string): string {
		return this.urlFor(`/playlist/${playlistId}/image${versionQuery(version)}`);
	}

	/** URL of a finished URL-import's local mp3 (valid until discarded). */
	urlForImportFile(importId: string): string {
		return this.urlFor(`/import/${importId}`);
	}

	/** Drops a track's cached audio, e.g. after it was deleted on the server. */
	evictTrack(trackId: string): void {
		this.cache.delete(trackId);
	}

	/**
	 * Every response carries `access-control-allow-origin: *`, because the
	 * webview origin (localhost:5173 in dev, views:// in prod) never matches
	 * this loopback origin. Everything but the <img> loads needs it:
	 *
	 * - whatever a programmatic fetch() reads — import files, and the head a
	 *   track's level is measured from — those being CORS-checked, so without
	 *   the header even the error responses are hidden from the caller;
	 * - track audio, because the <audio> element is marked crossOrigin so Web
	 *   Audio will expose its samples to the backdrop glow. That makes the
	 *   media load CORS-checked too, including every Range follow-up — a
	 *   missing header there fails playback outright, not just the glow.
	 *
	 * <img> loads don't need it, but are cheaper to cover than to special-case.
	 * The path secret already gates access, so `*` gives up nothing.
	 */
	private async handle(req: Request): Promise<Response> {
		// Chromium's media loader only sends CORS-safelisted headers, so no
		// preflight is expected — answered anyway so a stricter client can't
		// silently lose playback.
		if (req.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET, OPTIONS",
					"access-control-allow-headers": "range",
					"access-control-max-age": "86400",
				},
			});
		}
		const response = await this.route(req);
		response.headers.set("access-control-allow-origin", "*");
		return response;
	}

	private async route(req: Request): Promise<Response> {
		const { pathname } = new URL(req.url);

		// Local import files short-circuit before the session check — they never
		// touch the backend, so a live session is irrelevant.
		const importMatch = pathname.match(/^\/([^/]+)\/import\/([^/]+)$/);
		if (importMatch && importMatch[1] === this.secret) {
			if (req.method !== "GET") {
				return new Response("method not allowed", { status: 405 });
			}
			const filePath = this.resolveImportFile?.(importMatch[2]) ?? null;
			if (!filePath) {
				return new Response("not found", { status: 404 });
			}
			return new Response(Bun.file(filePath), {
				headers: { "content-type": "audio/mpeg" },
			});
		}
		// Track ids are uuids, so they match as an opaque segment; artists and
		// playlists are still serial ids. The audio regex is `$`-anchored on
		// the bare id and a segment can't span a `/`, so an `/image` or `/head`
		// suffix can never match it — the three track routes can't be confused.
		const trackMatch = pathname.match(/^\/([^/]+)\/track\/([^/]+)$/);
		const trackHeadMatch = pathname.match(/^\/([^/]+)\/track\/([^/]+)\/head$/);
		const artistImageMatch = pathname.match(
			/^\/([^/]+)\/artist\/(\d+)\/image$/,
		);
		const trackImageMatch = pathname.match(
			/^\/([^/]+)\/track\/([^/]+)\/image$/,
		);
		const playlistImageMatch = pathname.match(
			/^\/([^/]+)\/playlist\/(\d+)\/image$/,
		);
		const match =
			trackMatch ??
			trackHeadMatch ??
			artistImageMatch ??
			trackImageMatch ??
			playlistImageMatch;
		if (!match || match[1] !== this.secret) {
			return new Response("not found", { status: 404 });
		}
		if (req.method !== "GET") {
			return new Response("method not allowed", { status: 405 });
		}
		// Every payload is only ever requested from the authenticated UI, and
		// forwarding needs the server address either way — so a live session is
		// required even though the image routes themselves are public.
		const auth = this.api.auth;
		if (!auth) {
			return new Response("not logged in", { status: 401 });
		}
		const isTrack = trackMatch !== null;
		const isHead = trackHeadMatch !== null;
		const range = req.headers.get("range");

		if (isTrack || isHead) this.syncCacheToAuth(auth);
		if (isHead) return this.serveHead(match[2], auth);
		if (isTrack) {
			const cached = this.cache.get(match[2]);
			return cached
				? respondFromCache(cached, range)
				: this.serveAudio(match[2], range, auth);
		}

		// Carried straight back through to the backend: dropping it here would
		// leave every cover on the route's slow path, which re-reads the bytes
		// out of the database because it can't know which ones the caller meant.
		const version = imageVersion(req.url);
		const backendPath = trackImageMatch
			? trackImagePath(match[2], version)
			: playlistImageMatch
				? playlistImagePath(Number(match[2]), version)
				: artistImagePath(Number(match[2]), version);
		return this.serveImage(
			backendPath,
			version,
			req.headers.get("if-none-match"),
			auth,
		);
	}

	/** A track's audio, piped through and teed into the cache on the way past. */
	private async serveAudio(
		trackId: string,
		range: string | null,
		auth: Auth,
	): Promise<Response> {
		const upstream = await this.fetchAudio(trackId, auth, range);
		if (!upstream) return unreachable();
		return forward(
			upstream,
			upstream.body && this.teeIntoCache(trackId, range, upstream, upstream.body),
			PASSTHROUGH_HEADERS,
		);
	}

	/**
	 * A backend image, with the validator it can revalidate against and only what
	 * its URL entitles it to say about reuse.
	 */
	private async serveImage(
		backendPath: string,
		version: string | undefined,
		ifNoneMatch: string | null,
		auth: Auth,
	): Promise<Response> {
		// Relaying it is what turns a re-fetch of a cover the webview still holds
		// into a bodiless 304. Only an image can produce one: audio reaches the
		// webview without a validator, so it has nothing to revalidate with (see
		// IMAGE_HEADERS) and never sends one.
		const upstream = await this.fetchBackend(
			auth,
			backendPath,
			ifNoneMatch ? { "if-none-match": ifNoneMatch } : undefined,
		);
		if (!upstream) return unreachable();

		// A 304 says only "the copy you hold is current", so it carries no body
		// — bun answers one with an empty stream rather than null, and passing
		// that on relies on the Response constructor tolerating a body on a
		// status the spec gives none. Cancelled rather than dropped on the floor,
		// so the upstream connection is released now and not at the next GC.
		let body = upstream.body;
		if (upstream.status === 304) {
			void body?.cancel();
			body = null;
		}
		const response = forward(
			upstream,
			body,
			version === undefined ? IMAGE_HEADERS : PINNED_IMAGE_HEADERS,
		);
		if (version === undefined) {
			// Stated outright rather than left to the absence of a header: this
			// URL doesn't name the bytes behind it, so an edit would arrive under
			// the same one, and nothing may be reused without asking first.
			response.headers.set("cache-control", "no-cache");
		}
		return response;
	}

	/**
	 * A track's head, taken off the download the element is already making. Fetched
	 * outright only where there is none to share — a seek into an uncached track, a
	 * file too large for the cache, or a level asked for on a track never played.
	 */
	private async serveHead(trackId: string, auth: Auth): Promise<Response> {
		const cached = this.cache.get(trackId);
		if (cached) {
			return headResponse(
				cached.bytes.subarray(0, HEAD_BYTES),
				cached.contentType,
			);
		}
		const download = this.downloads.get(trackId) ?? this.expect(trackId);
		const head = await download.head;
		return head
			? headResponse(head.bytes, head.contentType)
			: this.fetchHead(trackId, auth);
	}

	/**
	 * A download this proxy has not seen yet but expects, left in the shared set
	 * for the element's request to fill. Unfilled, it is abandoned and whatever
	 * waits on its head is told there is nothing coming.
	 */
	private expect(trackId: string): TrackDownload {
		const download = new TrackDownload();
		this.downloads.set(trackId, download);
		setTimeout(() => {
			if (download.started) return;
			this.forget(trackId, download);
			download.abandon();
		}, HEAD_WAIT_MS);
		return download;
	}

	/** Drops a download from the shared set, unless it has already been replaced. */
	private forget(trackId: string, download: TrackDownload): void {
		if (this.downloads.get(trackId) === download) {
			this.downloads.delete(trackId);
		}
	}

	/** The head asked for outright, when there is no download to take it from. */
	private async fetchHead(trackId: string, auth: Auth): Promise<Response> {
		const range = `bytes=0-${HEAD_BYTES - 1}`;
		const upstream = await this.fetchAudio(trackId, auth, range);
		if (!upstream) return unreachable();
		if (!upstream.ok) {
			void upstream.body?.cancel();
			return new Response("no head", { status: upstream.status });
		}
		// A server free to ignore the Range answers with the whole file, so the
		// ceiling is enforced on the way in rather than trusted.
		const bytes = await readAtMost(upstream, HEAD_BYTES);
		if (!bytes) return new Response("no head", { status: 502 });
		return headResponse(bytes, contentTypeOf(upstream));
	}

	/**
	 * One authenticated request to the backend, and the one failure that arrives
	 * as no response rather than as a status: an unreachable backend is null.
	 * Every route out of this proxy goes through here, so the token header has
	 * one place to be spelled.
	 */
	private async fetchBackend(
		auth: Auth,
		path: string,
		extra?: Record<string, string>,
	): Promise<Response | null> {
		try {
			return await fetch(auth.baseUrl + path, {
				headers: { authorization: auth.token, ...extra },
			});
		} catch {
			return null;
		}
	}

	/**
	 * A track's audio, plus the answer only this proxy can give: a dead session is
	 * reported from here because this round-trip carries no RPC request for the
	 * status to travel back on.
	 */
	private async fetchAudio(
		trackId: string,
		auth: Auth,
		range: string | null,
	): Promise<Response | null> {
		const upstream = await this.fetchBackend(
			auth,
			trackAudioPath(trackId),
			range ? { range } : undefined,
		);
		if (upstream?.status === 401) this.onUnauthorized?.();
		return upstream;
	}

	/** Wipes the cache whenever the server/login the ids belong to changes. */
	private syncCacheToAuth(auth: Auth): void {
		const key = `${auth.baseUrl}\n${auth.token}`;
		if (key !== this.authKey) {
			this.cache.clear();
			this.authKey = key;
		}
	}

	/**
	 * If this response will deliver the whole file from byte 0, splits it and
	 * starts accumulating a copy for the cache; returns the branch to send to
	 * the client. Requests from a nonzero offset (seeks into uncached tracks)
	 * pass through untouched — a partial payload can't seed the cache.
	 */
	private teeIntoCache(
		trackId: string,
		range: string | null,
		upstream: Response,
		body: ReadableStream<Uint8Array<ArrayBuffer>>,
	): ReadableStream<Uint8Array<ArrayBuffer>> {
		const pending = this.downloads.get(trackId);
		if (pending?.started) return body;
		const coversWholeFile = range === null || range === "bytes=0-";
		const expectedBytes = coversWholeFile ? expectedTotalBytes(upstream) : null;
		if (expectedBytes === null || !this.cache.fits(expectedBytes)) {
			// The request a waiting scan expected, and it will not be shared: telling
			// the scan now saves it waiting out HEAD_WAIT_MS for nothing.
			if (pending) {
				this.forget(trackId, pending);
				pending.abandon();
			}
			return body;
		}
		const contentType = contentTypeOf(upstream);
		const [toClient, toCache] = body.tee();
		// An expectation a scan left behind is filled rather than replaced, so the
		// head it is waiting on is the one this download is about to deliver.
		const download = pending ?? new TrackDownload();
		this.downloads.set(trackId, download);
		void this.store(trackId, download, toCache, contentType, expectedBytes);
		return toClient;
	}

	/**
	 * Runs a download to its end and keeps it if it arrived whole. The auth
	 * snapshot is what stops one that straddled a re-login from polluting the
	 * new session's cache.
	 */
	private async store(
		trackId: string,
		download: TrackDownload,
		stream: ReadableStream<Uint8Array<ArrayBuffer>>,
		contentType: string,
		expectedBytes: number,
	): Promise<void> {
		const authKey = this.authKey;
		const bytes = await download.drain(stream, contentType, expectedBytes);
		if (bytes && authKey === this.authKey) {
			this.cache.set(trackId, { bytes, contentType });
		}
		this.forget(trackId, download);
	}
}

/** The upstream's answer, rebuilt with only the headers this proxy passes on. */
function forward(
	upstream: Response,
	body: ReadableStream<Uint8Array<ArrayBuffer>> | null,
	forwarded: readonly string[],
): Response {
	const headers = new Headers();
	for (const name of forwarded) {
		const value = upstream.headers.get(name);
		if (value) headers.set(name, value);
	}
	return new Response(body, { status: upstream.status, headers });
}

/**
 * A head, always as a plain 200 whichever way it was come by, so its one reader
 * has a single shape to check.
 */
function headResponse(
	bytes: Uint8Array<ArrayBuffer>,
	contentType: string,
): Response {
	return new Response(bytes, { headers: { "content-type": contentType } });
}

/** The one failure that reaches this proxy as no response at all. */
function unreachable(): Response {
	return new Response("backend unreachable", { status: 502 });
}

/** Reads at most `limit` bytes, then releases the connection rather than the GC. */
async function readAtMost(
	response: Response,
	limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	if (!response.body) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		// The chunk that crosses the limit is already on the wire, so it is read
		// and then truncated off rather than avoided.
		while (received < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			received += value.byteLength;
		}
	} catch {
		return null;
	} finally {
		void reader.cancel();
	}
	return received > 0 ? Buffer.concat(chunks, Math.min(received, limit)) : null;
}

/**
 * Total size the response body will deliver, or null when that's unknowable
 * (no caching then). A 206's content-range must span the entire file — the
 * request asked for `bytes=0-`, but a server could still answer with less.
 */
function expectedTotalBytes(upstream: Response): number | null {
	if (upstream.status === 200) {
		const length = Number(upstream.headers.get("content-length"));
		return Number.isInteger(length) && length > 0 ? length : null;
	}
	if (upstream.status !== 206) return null;
	const match = upstream.headers
		.get("content-range")
		?.match(/^bytes 0-(\d+)\/(\d+)$/);
	if (!match) return null;
	const total = Number(match[2]);
	return Number(match[1]) === total - 1 ? total : null;
}
