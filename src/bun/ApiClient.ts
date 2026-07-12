import { initClient } from "@ts-rest/core";
import { ApiContract } from "../../contract/contract";
import type {
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
	private client: ReturnType<typeof createClient> | null = null;

	async login(params: LoginParams): Promise<RpcResult> {
		const { host, port, username, password } = params;
		const baseUrl = `http://${host}:${port}`;
		this.client = null;
		try {
			const res = await createClient(baseUrl).login({
				body: { username, password },
			});
			if (res.status === 200) {
				this.client = createClient(baseUrl, res.body.token);
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
		const client = this.client;
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
			if (res.status === 401) this.client = null;
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
}

function errorText(body: unknown, fallback: string): string {
	return typeof body === "string" && body.length > 0 ? body : fallback;
}
