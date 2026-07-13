import { initClient } from "@ts-rest/core";
import { ApiContract } from "../../contract/contract";
import type {
	ListTracksResult,
	LoginParams,
	RpcResult,
	UploadTrackParams,
} from "../shared/rpcSchema";

function createClient(baseUrl: string, token?: string) {
	return initClient(ApiContract, {
		baseUrl,
		// Raw token per the contract's `authorization` header; if the backend
		// ever wants a `Bearer ` prefix this is the one place to add it.
		baseHeaders: token ? { authorization: token } : {},
	});
}

/**
 * All server I/O lives here in the bun process: no webview CORS issues,
 * the session token never leaves bun memory, and Bun.gzipSync is available
 * for track compression.
 */
export class ApiClient {
	// Single source of truth for auth state; the client is derived from
	// baseUrl+token once at login so the two can never diverge.
	private session: {
		baseUrl: string;
		token: string;
		client: ReturnType<typeof createClient>;
	} | null = null;

	/** Server address + token for the stream proxy; null when logged out. */
	get auth(): { baseUrl: string; token: string } | null {
		if (!this.session) return null;
		const { baseUrl, token } = this.session;
		return { baseUrl, token };
	}

	/** Drops the session, e.g. when the server rejects the token (401). */
	expireSession(): void {
		this.session = null;
	}

	async login(params: LoginParams): Promise<RpcResult> {
		const { host, port, username, password } = params;
		const baseUrl = `http://${host}:${port}`;
		this.expireSession();
		try {
			const res = await createClient(baseUrl).login({
				body: { username, password },
			});
			if (res.status === 200) {
				const token = res.body.token;
				this.session = { baseUrl, token, client: createClient(baseUrl, token) };
				return { ok: true };
			}
			return {
				ok: false,
				status: res.status,
				error: errorText(res.body, `Login failed (HTTP ${res.status})`),
			};
		} catch {
			return {
				ok: false,
				error: `Cannot reach ${baseUrl} — is the server running?`,
			};
		}
	}

	async uploadTrack(params: UploadTrackParams): Promise<RpcResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		const raw = Buffer.from(params.dataBase64, "base64");
		const gzipped = Bun.gzipSync(new Uint8Array(raw));
		try {
			const res = await client.postTrack({
				body: {
					title: params.title,
					duration: Math.round(params.durationSec),
					compressed_data: Buffer.from(gzipped).toString("base64"),
				},
			});
			if (res.status === 200) return { ok: true };
			if (res.status === 401) this.expireSession();
			if (res.status === 413) {
				return {
					ok: false,
					status: res.status,
					error:
						"Track too large for the server (HTTP 413) — raise the server's request body size limit.",
				};
			}
			return {
				ok: false,
				status: res.status,
				error: errorText(res.body, `Upload failed (HTTP ${res.status})`),
			};
		} catch {
			return { ok: false, error: "Upload failed — server unreachable" };
		}
	}

	/**
	 * Server track listing. `urlForTrack` maps a server track id to its
	 * stream-proxy URL so complete RemoteTracks are assembled in one place.
	 */
	async listTracks(
		urlForTrack: (serverId: number) => string,
	): Promise<ListTracksResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		try {
			const res = await client.getTracks();
			if (res.status === 200) {
				return {
					ok: true,
					tracks: res.body.map((track) => ({
						id: track.id,
						title: track.title,
						artist: track.artists.join(", ") || undefined,
						durationSec: track.duration,
						streamUrl: urlForTrack(track.id),
					})),
				};
			}
			if (res.status === 401) this.expireSession();
			return {
				ok: false,
				status: res.status,
				error: errorText(
					res.body,
					`Loading the track list failed (HTTP ${res.status})`,
				),
			};
		} catch {
			return { ok: false, error: "Loading the track list failed — server unreachable" };
		}
	}
}

function errorText(body: unknown, fallback: string): string {
	return typeof body === "string" && body.length > 0 ? body : fallback;
}
