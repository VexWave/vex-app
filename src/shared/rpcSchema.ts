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
 * Failed handler results cross the RPC boundary as plain values instead of
 * thrown errors so the HTTP status (401 detection) survives intact.
 */
export interface RpcFailure {
	ok: false;
	/** HTTP status when the server answered; absent on transport failures. */
	status?: number;
	error: string;
}

export type RpcResult = { ok: true } | RpcFailure;

export interface UploadTrackParams {
	title: string;
	/** Float; the bun side rounds it to the contract's int32. */
	durationSec: number;
	/** Raw (uncompressed) file bytes, base64-encoded. */
	dataBase64: string;
}

export interface RemoteTrack {
	/** Server-side track id. */
	id: number;
	title: string;
	artist?: string;
	durationSec: number;
	/**
	 * Loopback URL of the bun-side stream proxy for this track. The audio
	 * element plays it directly; bytes stream through the bun process, which
	 * attaches the session token — so playback starts as soon as enough is
	 * buffered while the rest keeps downloading.
	 */
	streamUrl: string;
}

export type ListTracksResult = { ok: true; tracks: RemoteTrack[] } | RpcFailure;

export interface CreateArtistParams {
	name: string;
	/** Optional artist image URL, passed through to the server as-is. */
	imageUrl?: string;
}

export interface DeleteArtistParams {
	/** Server-side artist id. */
	id: number;
}

export interface RemoteArtist {
	/** Server-side artist id. */
	id: number;
	name: string;
	imageUrl?: string;
}

export type ListArtistsResult =
	| { ok: true; artists: RemoteArtist[] }
	| RpcFailure;

export type PlayerRPC = {
	bun: RPCSchema<{
		requests: {
			login: { params: LoginParams; response: RpcResult };
			uploadTrack: { params: UploadTrackParams; response: RpcResult };
			listTracks: { params: undefined; response: ListTracksResult };
			listArtists: { params: undefined; response: ListArtistsResult };
			createArtist: { params: CreateArtistParams; response: RpcResult };
			deleteArtist: { params: DeleteArtistParams; response: RpcResult };
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			/**
			 * Pushed by the bun process when the stream proxy hits a 401 —
			 * the only server round-trip that doesn't flow through an RPC
			 * request, so the webview can't see the status itself.
			 */
			sessionExpired: { reason: string };
		};
	}>;
};
