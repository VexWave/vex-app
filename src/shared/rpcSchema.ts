// Shared RPC schema between the bun process and the webview.
// Only import TYPES from this file's electrobun imports — value imports of
// "electrobun/bun" would break the browser bundle.
import type { RPCSchema } from "electrobun/bun";

export interface LoginParams {
	host: string;
	port: number;
	username: string;
	password: string;
}

/**
 * Handler results cross the RPC boundary as plain values instead of thrown
 * errors so the HTTP status (401 detection) survives intact.
 */
export type RpcResult =
	| { ok: true }
	| { ok: false; status?: number; error: string };

export interface UploadTrackParams {
	title: string;
	/** Float; the bun side rounds it to the contract's int32. */
	durationSec: number;
	/** Raw (uncompressed) file bytes, base64-encoded. */
	dataBase64: string;
}

export type PlayerRPC = {
	bun: RPCSchema<{
		requests: {
			login: { params: LoginParams; response: RpcResult };
			uploadTrack: { params: UploadTrackParams; response: RpcResult };
		};
	}>;
	webview: RPCSchema<{ requests: {}; messages: {} }>;
};
