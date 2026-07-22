import {
	artistImagePath,
	trackAudioPath,
	trackImagePath,
} from "../../contract/contract";
import type { ApiClient } from "./ApiClient";
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
	private readonly inflight = new Set<number>();
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
		/**
		 * Called with the full set of cached track ids whenever cache membership
		 * changes (track fully downloaded, evicted, or the cache was wiped) — the
		 * UI marks cached tracks as instant to play.
		 */
		private readonly onCacheChanged?: (trackIds: number[]) => void,
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

	/** Stable stream URL for a server track. */
	urlForTrack(trackId: number): string {
		const { port } = this.ensureServer();
		return `http://127.0.0.1:${port}/${this.secret}/track/${trackId}`;
	}

	/** Stable avatar URL for a server artist. */
	urlForArtistImage(artistId: number): string {
		const { port } = this.ensureServer();
		return `http://127.0.0.1:${port}/${this.secret}/artist/${artistId}/image`;
	}

	/** Stable cover-image URL for a server track. */
	urlForTrackImage(trackId: number): string {
		const { port } = this.ensureServer();
		return `http://127.0.0.1:${port}/${this.secret}/track/${trackId}/image`;
	}

	/** URL of a finished URL-import's local mp3 (valid until discarded). */
	urlForImportFile(importId: string): string {
		const { port } = this.ensureServer();
		return `http://127.0.0.1:${port}/${this.secret}/import/${importId}`;
	}

	/** Drops a track's cached audio, e.g. after it was deleted on the server. */
	evictTrack(trackId: number): void {
		if (this.cache.delete(trackId)) this.onCacheChanged?.(this.cache.ids());
	}

	/**
	 * Ids of every fully-cached track, synced against the live session first so
	 * a fetch right after a re-login can't report the previous session's ids.
	 */
	cachedTrackIds(): number[] {
		const auth = this.api.auth;
		if (!auth) return [];
		this.syncCacheToAuth(auth);
		return this.cache.ids();
	}

	private async handle(req: Request): Promise<Response> {
		const { pathname } = new URL(req.url);

		// Local import files short-circuit before the session check — they never
		// touch the backend, so a live session is irrelevant.
		const importMatch = pathname.match(/^\/([^/]+)\/import\/([^/]+)$/);
		if (importMatch && importMatch[1] === this.secret) {
			// Unlike the audio/img consumers (no-cors element loads), imports are
			// read with a programmatic fetch(), which IS CORS-checked — and the
			// webview origin (localhost:5173 in dev, views:// in prod) never
			// matches this loopback origin. Without the header every response,
			// success or error, is blocked before the caller can see it. The
			// path secret already gates access, so "*" gives up nothing.
			const cors = { "access-control-allow-origin": "*" };
			if (req.method !== "GET") {
				return new Response("method not allowed", { status: 405, headers: cors });
			}
			const filePath = this.resolveImportFile?.(importMatch[2]) ?? null;
			if (!filePath) {
				return new Response("not found", { status: 404, headers: cors });
			}
			return new Response(Bun.file(filePath), {
				headers: { ...cors, "content-type": "audio/mpeg" },
			});
		}
		// The audio regex is `$`-anchored on the bare id, so a `/image` suffix
		// can never match it — no ambiguity between audio and cover-image URLs.
		const trackMatch = pathname.match(/^\/([^/]+)\/track\/(\d+)$/);
		const artistImageMatch = pathname.match(
			/^\/([^/]+)\/artist\/(\d+)\/image$/,
		);
		const trackImageMatch = pathname.match(/^\/([^/]+)\/track\/(\d+)\/image$/);
		const match = trackMatch ?? artistImageMatch ?? trackImageMatch;
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
			const cached = this.cache.get(Number(match[2]));
			if (cached) return respondFromCache(cached, range);
		}

		const backendPath = isTrack
			? trackAudioPath(Number(match[2]))
			: trackImageMatch
				? trackImagePath(Number(match[2]))
				: artistImagePath(Number(match[2]));

		const headers: Record<string, string> = { authorization: auth.token };
		if (range) headers.range = range;

		let upstream: Response;
		try {
			upstream = await fetch(auth.baseUrl + backendPath, { headers });
		} catch {
			return new Response("backend unreachable", { status: 502 });
		}

		// Only track audio is token-gated; a 401 there means the session died.
		if (isTrack && upstream.status === 401) this.onUnauthorized?.();

		let body = upstream.body;
		if (isTrack && body) {
			body = this.teeIntoCache(Number(match[2]), range, upstream, body);
		}

		const responseHeaders = new Headers();
		for (const name of PASSTHROUGH_HEADERS) {
			const value = upstream.headers.get(name);
			if (value) responseHeaders.set(name, value);
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
			if (this.cache.clear()) this.onCacheChanged?.([]);
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
		trackId: number,
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
		trackId: number,
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
			this.onCacheChanged?.(this.cache.ids());
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
