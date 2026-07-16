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
	/** Integer milliseconds; the webview converts the tag's float seconds once. */
	durationMs: number;
	/** Raw (uncompressed) file bytes, base64-encoded. */
	dataBase64: string;
	/** Raw cover-image bytes, base64-encoded. Omit for no cover. */
	coverBase64?: string;
	/** Artist ids to link to the track (empty/omitted → none). */
	artistIds?: number[];
}

export interface RemoteTrack {
	/** Server-side track id. */
	id: number;
	title: string;
	/** Joined artist names for display (undefined when the track has none). */
	artist?: string;
	/** The track's linked artist names, as the server returns them — used to
	 * pre-select the currently-linked artists when editing. */
	artists: string[];
	/** Track length in milliseconds, as the server returns it. */
	durationMs: number;
	/**
	 * Loopback URL of the bun-side stream proxy for this track. The audio
	 * element plays it directly; bytes stream through the bun process, which
	 * attaches the session token — so playback starts as soon as enough is
	 * buffered while the rest keeps downloading.
	 */
	streamUrl: string;
	/**
	 * Loopback URL of the bun-side stream proxy for this track's cover image,
	 * or undefined when the track has no cover. Same pattern as
	 * `RemoteArtist.imageUrl`: the webview loads it directly and never reaches
	 * the backend.
	 */
	coverUrl?: string;
}

export type ListTracksResult = { ok: true; tracks: RemoteTrack[] } | RpcFailure;

export interface DeleteTrackParams {
	/** Server-side track id. */
	id: number;
}

export interface EditTrackParams {
	/** Server-side track id. */
	id: number;
	title?: string;
	/** Replaces the track's artist links entirely (empty array clears them). */
	artistIds?: number[];
	/** New cover bytes, base64; `null` removes the cover; omit = unchanged. */
	coverBase64?: string | null;
}

export interface CreateArtistParams {
	name: string;
	/** Raw avatar image bytes, base64-encoded. Omit for no avatar. */
	imageBase64?: string;
}

export interface EditArtistParams {
	/** Server-side artist id. */
	id: number;
	name?: string;
	/**
	 * New avatar image bytes, base64-encoded; `null` removes the avatar;
	 * omit to leave it unchanged.
	 */
	imageBase64?: string | null;
}

export interface DeleteArtistParams {
	/** Server-side artist id. */
	id: number;
}

export interface RemoteArtist {
	/** Server-side artist id. */
	id: number;
	name: string;
	/**
	 * Loopback URL of the bun-side stream proxy for this artist's avatar, or
	 * undefined when the artist has no image. The server returns the backend's
	 * own image-route path; bun rewrites it to a proxy URL the webview can load
	 * directly (the webview never reaches the backend).
	 */
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
			deleteTrack: { params: DeleteTrackParams; response: RpcResult };
			editTrack: { params: EditTrackParams; response: RpcResult };
			listTracks: { params: undefined; response: ListTracksResult };
			listArtists: { params: undefined; response: ListArtistsResult };
			createArtist: { params: CreateArtistParams; response: RpcResult };
			editArtist: { params: EditArtistParams; response: RpcResult };
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
