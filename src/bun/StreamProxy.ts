import { trackAudioPath } from "../../contract/contract";
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
 * Loopback HTTP server that lets the webview's audio element stream tracks
 * progressively. The audio element plays http://127.0.0.1:<port>/… URLs;
 * this proxy forwards each request to the backend's raw audio route with
 * the session token attached and pipes the response body straight through —
 * the token never enters the webview, and playback starts as soon as the
 * browser has buffered enough while the rest keeps downloading. `Range`
 * headers pass through both ways, which is what makes seeking into
 * not-yet-downloaded regions instant (Chromium re-requests from the offset).
 *
 * The server binds only the loopback interface, and the random path secret
 * keeps other local processes from guessing playable URLs.
 */
export class StreamProxy {
	private server: ReturnType<typeof Bun.serve> | null = null;
	private readonly secret = crypto.randomUUID();

	/**
	 * `onUnauthorized` fires when the backend rejects the session token on a
	 * stream request — the one server round-trip that doesn't go through an
	 * RPC request, so the caller must propagate the expiry itself.
	 */
	constructor(
		private readonly api: ApiClient,
		private readonly onUnauthorized?: () => void,
	) {}

	/** Stable stream URL for a server track; starts the proxy on first use. */
	urlForTrack(trackId: number): string {
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
		return `http://127.0.0.1:${this.server.port}/${this.secret}/track/${trackId}`;
	}

	private async handle(req: Request): Promise<Response> {
		const match = new URL(req.url).pathname.match(/^\/([^/]+)\/track\/(\d+)$/);
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

		const headers: Record<string, string> = { authorization: auth.token };
		const range = req.headers.get("range");
		if (range) headers.range = range;

		let upstream: Response;
		try {
			upstream = await fetch(auth.baseUrl + trackAudioPath(Number(match[2])), {
				headers,
			});
		} catch {
			return new Response("backend unreachable", { status: 502 });
		}

		if (upstream.status === 401) this.onUnauthorized?.();

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
