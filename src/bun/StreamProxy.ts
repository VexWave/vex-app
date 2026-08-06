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

/**
 * Loopback HTTP server that lets the webview load backend binary payloads it
 * can't reach itself (no CORS, and the session token never enters the webview).
 * The webview requests http://127.0.0.1:<port>/… URLs; this proxy forwards each
 * to the matching backend route with the token attached and pipes the response
 * body straight through. Two kinds of payload go through it:
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
/** Upper bound for cached audio; LRU eviction keeps the total under this. */
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

export class StreamProxy {
	private server: ReturnType<typeof Bun.serve> | null = null;
	private readonly secret = crypto.randomUUID();
	private readonly cache = new TrackCache(MAX_CACHE_BYTES);
	/** Track ids with a cache download in flight — never tee the same id twice. */
	private readonly inflight = new Set<string>();
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
	 * this loopback origin. Two of the three consumers need it:
	 *
	 * - import files, read with a programmatic fetch() — CORS-checked, so
	 *   without the header even the error responses are hidden from the caller;
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
		// the bare id and a segment can't span a `/`, so a `/image` suffix can
		// never match it — no ambiguity between audio and cover-image URLs.
		const trackMatch = pathname.match(/^\/([^/]+)\/track\/([^/]+)$/);
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
			trackMatch ?? artistImageMatch ?? trackImageMatch ?? playlistImageMatch;
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
		const range = req.headers.get("range");

		if (isTrack) {
			this.syncCacheToAuth(auth);
			const cached = this.cache.get(match[2]);
			if (cached) return respondFromCache(cached, range);
		}

		// Carried straight back through to the backend: dropping it here would
		// leave every cover on the route's slow path, which re-reads the bytes
		// out of the database because it can't know which ones the caller meant.
		const version = imageVersion(req.url);
		const backendPath = isTrack
			? trackAudioPath(match[2])
			: trackImageMatch
				? trackImagePath(match[2], version)
				: playlistImageMatch
					? playlistImagePath(Number(match[2]), version)
					: artistImagePath(Number(match[2]), version);

		const headers: Record<string, string> = { authorization: auth.token };
		if (range) headers.range = range;
		// Only an image can produce one — audio reaches the webview without a
		// validator, so it has nothing to revalidate with (see IMAGE_HEADERS) —
		// and relaying it is what turns a re-fetch of a cover the webview still
		// holds into a bodiless 304.
		const ifNoneMatch = req.headers.get("if-none-match");
		if (!isTrack && ifNoneMatch) headers["if-none-match"] = ifNoneMatch;

		let upstream: Response;
		try {
			upstream = await fetch(auth.baseUrl + backendPath, { headers });
		} catch {
			return new Response("backend unreachable", { status: 502 });
		}

		// Only track audio is token-gated; a 401 there means the session died.
		if (isTrack && upstream.status === 401) this.onUnauthorized?.();

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
		if (isTrack && body) {
			body = this.teeIntoCache(match[2], range, upstream, body);
		}

		const responseHeaders = new Headers();
		const forwarded = isTrack
			? PASSTHROUGH_HEADERS
			: version === undefined
				? IMAGE_HEADERS
				: PINNED_IMAGE_HEADERS;
		for (const name of forwarded) {
			const value = upstream.headers.get(name);
			if (value) responseHeaders.set(name, value);
		}
		if (!isTrack && version === undefined) {
			// Stated outright rather than left to the absence of a header: this
			// URL doesn't name the bytes behind it, so an edit would arrive under
			// the same one, and nothing may be reused without asking first.
			responseHeaders.set("cache-control", "no-cache");
		}
		return new Response(body, {
			status: upstream.status,
			headers: responseHeaders,
		});
	}

	/** Wipes the cache whenever the server/login the ids belong to changes. */
	private syncCacheToAuth(auth: { baseUrl: string; token: string }): void {
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
		const coversWholeFile = range === null || range === "bytes=0-";
		if (!coversWholeFile || this.inflight.has(trackId)) return body;
		const expectedBytes = expectedTotalBytes(upstream);
		if (expectedBytes === null || !this.cache.fits(expectedBytes)) return body;
		const contentType =
			upstream.headers.get("content-type") ?? "application/octet-stream";
		const [toClient, toCache] = body.tee();
		void this.accumulate(
			trackId,
			toCache,
			contentType,
			expectedBytes,
			this.authKey,
		);
		return toClient;
	}

	/**
	 * Drains the cache branch of a teed response. The byte count is checked
	 * against the declared total so a dropped upstream connection (which can
	 * surface as a clean EOF) can never cache a truncated file, and the auth
	 * snapshot keeps a download that straddled a re-login from polluting the
	 * new session's cache.
	 */
	private async accumulate(
		trackId: string,
		stream: ReadableStream<Uint8Array<ArrayBuffer>>,
		contentType: string,
		expectedBytes: number,
		authKey: string | null,
	): Promise<void> {
		this.inflight.add(trackId);
		const reader = stream.getReader();
		try {
			const chunks: Uint8Array[] = [];
			let received = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > expectedBytes) {
					await reader.cancel();
					return;
				}
				chunks.push(value);
			}
			if (received !== expectedBytes || authKey !== this.authKey) return;
			const bytes = new Uint8Array(received);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			this.cache.set(trackId, { bytes, contentType });
		} catch {
			// Upstream died mid-download; the partial bytes are useless.
		} finally {
			this.inflight.delete(trackId);
		}
	}
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
