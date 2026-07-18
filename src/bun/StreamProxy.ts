import {
	artistImagePath,
	trackAudioPath,
	trackImagePath,
} from "../../contract/contract";
import type { ApiClient } from "./ApiClient";

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
 *   can't see the status otherwise).
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
		const backendPath = isTrack
			? trackAudioPath(Number(match[2]))
			: trackImageMatch
				? trackImagePath(Number(match[2]))
				: artistImagePath(Number(match[2]));

		const headers: Record<string, string> = { authorization: auth.token };
		const range = req.headers.get("range");
		if (range) headers.range = range;

		let upstream: Response;
		try {
			upstream = await fetch(auth.baseUrl + backendPath, { headers });
		} catch {
			return new Response("backend unreachable", { status: 502 });
		}

		// Only track audio is token-gated; a 401 there means the session died.
		if (isTrack && upstream.status === 401) this.onUnauthorized?.();

		const responseHeaders = new Headers();
		for (const name of PASSTHROUGH_HEADERS) {
			const value = upstream.headers.get(name);
			if (value) responseHeaders.set(name, value);
		}
		return new Response(upstream.body, {
			status: upstream.status,
			headers: responseHeaders,
		});
	}
}
