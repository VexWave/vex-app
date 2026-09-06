import {
	artistImagePath,
	playlistImagePath,
	trackAudioPath,
	trackImagePath,
} from "../../contract/contract";
import type { ApiClient } from "./ApiClient";
import { imageVersion, versionQuery } from "./imageVersion";
import { TrackCache, respondFromCache } from "./TrackCache";

// content-length stays out: the body is a piped stream whose length can fall
// short if upstream drops. Chromium opens media with Range: bytes=0-, so the
// total reaches it via content-range instead.
const PASSTHROUGH_HEADERS = [
	"content-type",
	"content-range",
	"accept-ranges",
] as const;

const IMAGE_HEADERS = [...PASSTHROUGH_HEADERS, "etag"] as const;

const PINNED_IMAGE_HEADERS = [...IMAGE_HEADERS, "cache-control"] as const;

const MAX_CACHE_BYTES = 256 * 1024 * 1024;

type Auth = { baseUrl: string; token: string };

const NEUTRAL_TYPE = "application/octet-stream";
const contentTypeOf = (response: Response): string =>
	response.headers.get("content-type") ?? NEUTRAL_TYPE;

const HEAD_BYTES = 1_500_000;

const HEAD_WAIT_MS = 2000;

type Head = { bytes: Uint8Array<ArrayBuffer>; contentType: string };

class TrackDownload {
	readonly head: Promise<Head | null>;
	private settle: ((head: Head | null) => void) | null = null;
	started = false;

	constructor() {
		this.head = new Promise((resolve) => {
			this.settle = resolve;
		});
	}

	abandon(): void {
		this.deliver(null);
	}

	private deliver(head: Head | null): void {
		this.settle?.(head);
		this.settle = null;
	}

	async drain(
		stream: ReadableStream<Uint8Array<ArrayBuffer>>,
		contentType: string,
		expectedBytes: number,
	): Promise<Uint8Array<ArrayBuffer> | null> {
		this.started = true;
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
			if (this.settle && received > 0) {
				this.deliver({ bytes: bytes.slice(0, received), contentType });
			}
			return received === expectedBytes ? bytes : null;
		} catch {
			return null;
		} finally {
			this.deliver(null);
		}
	}
}

export class StreamProxy {
	private server: ReturnType<typeof Bun.serve> | null = null;
	private readonly secret = crypto.randomUUID();
	private readonly cache = new TrackCache(MAX_CACHE_BYTES);
	private readonly downloads = new Map<string, TrackDownload>();
	private authKey: string | null = null;

	constructor(
		private readonly api: ApiClient,
		private readonly onUnauthorized?: () => void,
		private readonly resolveImportFile?: (importId: string) => string | null,
	) {}

	private ensureServer(): NonNullable<typeof this.server> {
		if (!this.server) {
			this.server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				// Chromium pauses media downloads once its buffer is full; keep those idle
				// connections alive as long as Bun allows.
				idleTimeout: 255,
				fetch: (req) => this.handle(req),
			});
		}
		return this.server;
	}

	private urlFor(path: string): string {
		const { port } = this.ensureServer();
		return `http://127.0.0.1:${port}/${this.secret}${path}`;
	}

	urlForTrack(trackId: string): string {
		return this.urlFor(`/track/${trackId}`);
	}

	urlForArtistImage(artistId: number, version?: string): string {
		return this.urlFor(`/artist/${artistId}/image${versionQuery(version)}`);
	}

	urlForTrackImage(trackId: string, version?: string): string {
		return this.urlFor(`/track/${trackId}/image${versionQuery(version)}`);
	}

	urlForPlaylistImage(playlistId: number, version?: string): string {
		return this.urlFor(`/playlist/${playlistId}/image${versionQuery(version)}`);
	}

	urlForImportFile(importId: string): string {
		return this.urlFor(`/import/${importId}`);
	}

	evictTrack(trackId: string): void {
		this.cache.delete(trackId);
	}

	private async handle(req: Request): Promise<Response> {
		// Chromium's media loader sends only CORS-safelisted headers, so no preflight
		// is expected; answered anyway for stricter clients.
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

	private async serveImage(
		backendPath: string,
		version: string | undefined,
		ifNoneMatch: string | null,
		auth: Auth,
	): Promise<Response> {
		const upstream = await this.fetchBackend(
			auth,
			backendPath,
			ifNoneMatch ? { "if-none-match": ifNoneMatch } : undefined,
		);
		if (!upstream) return unreachable();

		let body = upstream.body;
		// The spec gives a 304 no body; cancelled so the upstream connection is
		// released now rather than at the next GC.
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
			response.headers.set("cache-control", "no-cache");
		}
		return response;
	}

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

	private forget(trackId: string, download: TrackDownload): void {
		if (this.downloads.get(trackId) === download) {
			this.downloads.delete(trackId);
		}
	}

	private async fetchHead(trackId: string, auth: Auth): Promise<Response> {
		const range = `bytes=0-${HEAD_BYTES - 1}`;
		const upstream = await this.fetchAudio(trackId, auth, range);
		if (!upstream) return unreachable();
		if (!upstream.ok) {
			void upstream.body?.cancel();
			return new Response("no head", { status: upstream.status });
		}
		const bytes = await readAtMost(upstream, HEAD_BYTES);
		if (!bytes) return new Response("no head", { status: 502 });
		return headResponse(bytes, contentTypeOf(upstream));
	}

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

	private syncCacheToAuth(auth: Auth): void {
		const key = `${auth.baseUrl}\n${auth.token}`;
		if (key !== this.authKey) {
			this.cache.clear();
			this.authKey = key;
		}
	}

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
			if (pending) {
				this.forget(trackId, pending);
				pending.abandon();
			}
			return body;
		}
		const contentType = contentTypeOf(upstream);
		const [toClient, toCache] = body.tee();
		const download = pending ?? new TrackDownload();
		this.downloads.set(trackId, download);
		void this.store(trackId, download, toCache, contentType, expectedBytes);
		return toClient;
	}

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

function headResponse(
	bytes: Uint8Array<ArrayBuffer>,
	contentType: string,
): Response {
	return new Response(bytes, { headers: { "content-type": contentType } });
}

function unreachable(): Response {
	return new Response("backend unreachable", { status: 502 });
}

async function readAtMost(
	response: Response,
	limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	if (!response.body) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
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
