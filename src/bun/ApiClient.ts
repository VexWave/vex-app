import { initClient } from "@ts-rest/core";
import {
	ApiContract,
	MAX_AUDIO_BASE64,
	MAX_IMAGE_BASE64,
} from "../../contract/contract";
import {
	MAX_AUDIO_BYTES,
	MAX_IMAGE_BYTES,
	base64Length,
} from "../shared/limits";
import type {
	CreateArtistParams,
	CreatePlaylistParams,
	DeleteArtistParams,
	DeletePlaylistParams,
	DeleteTrackParams,
	EditArtistParams,
	EditPlaylistParams,
	EditTrackParams,
	ListArtistsResult,
	ListPlaylistsResult,
	ListTracksResult,
	LoginParams,
	LoginResult,
	RestoreSessionParams,
	RpcFailure,
	RpcResult,
	UploadTrackParams,
} from "../shared/rpcSchema";

// `src/shared/limits.ts` and the contract are the same fence in different units,
// and the webview checks payload sizes against the copy it can import. If the
// two stop agreeing it would wave through payloads the server rejects — so a
// disagreement is a startup failure here rather than a surprise mid-upload.
if (
	base64Length(MAX_AUDIO_BYTES) > MAX_AUDIO_BASE64 ||
	base64Length(MAX_IMAGE_BYTES) > MAX_IMAGE_BASE64
) {
	throw new Error(
		"src/shared/limits.ts exceeds the contract's base64 caps — the two have to move together.",
	);
}

function createClient(baseUrl: string, token?: string) {
	return initClient(ApiContract, {
		baseUrl,
		// Raw token per the contract's `authorization` header; if the backend
		// ever wants a `Bearer ` prefix this is the one place to add it.
		baseHeaders: token ? { authorization: token } : {},
	});
}

/**
 * All server I/O lives here in the bun process: no webview CORS issues, and the
 * session token is used only from here. The token is handed to the webview once
 * (on login) purely so it can be persisted for restart; see
 * `login`/`restoreSession`.
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

	/**
	 * Re-establishes a session from a token the webview persisted, without a
	 * login round-trip. The token isn't checked here — the next authenticated
	 * call validates it (a 401 there falls back to the login screen).
	 */
	restoreSession(params: RestoreSessionParams): RpcResult {
		const { host, port, token } = params;
		const baseUrl = `http://${host}:${port}`;
		this.session = { baseUrl, token, client: createClient(baseUrl, token) };
		return { ok: true };
	}

	async login(params: LoginParams): Promise<LoginResult> {
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
				return { ok: true, token };
			}
			return failure(res, `Login failed (HTTP ${res.status})`);
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
		try {
			const res = await client.postTrack({
				body: {
					title: params.title,
					// Already an integer (the webview rounds the tag's float seconds).
					duration: params.durationMs,
					data: params.dataBase64,
					cover: params.coverBase64,
					artistIds: params.artistIds,
				},
			});
			if (res.status === 200) return { ok: true };
			if (res.status === 401) this.expireSession();
			return failure(res, `Upload failed (HTTP ${res.status})`, "audio");
		} catch {
			return { ok: false, error: "Upload failed — server unreachable" };
		}
	}

	async deleteTrack(params: DeleteTrackParams): Promise<RpcResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		try {
			const res = await client.deleteTrack({ body: { id: params.id } });
			if (res.status === 200) return { ok: true };
			if (res.status === 401) this.expireSession();
			return failure(res, `Deleting the track failed (HTTP ${res.status})`);
		} catch {
			return { ok: false, error: "Deleting the track failed — server unreachable" };
		}
	}

	async editTrack(params: EditTrackParams): Promise<RpcResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		try {
			const res = await client.editTrack({
				body: {
					id: params.id,
					title: params.title,
					artistIds: params.artistIds,
					// undefined drops off the wire (unchanged); null survives (remove).
					cover: params.coverBase64,
				},
			});
			if (res.status === 200) return { ok: true };
			if (res.status === 401) this.expireSession();
			return failure(
				res,
				`Editing the track failed (HTTP ${res.status})`,
				"image",
			);
		} catch {
			return { ok: false, error: "Editing the track failed — server unreachable" };
		}
	}

	/**
	 * Server track listing. `urlForTrack` maps a server track id to its
	 * stream-proxy URL, and `urlForTrackImage` to its cover-image proxy URL, so
	 * complete RemoteTracks are assembled in one place. Like `listArtists`'
	 * imageUrl rewrite, `coverUrl` stays undefined unless the server sent one.
	 *
	 * The server's order (oldest first) is passed through untouched — it is
	 * what tells the webview which tracks are the recent uploads.
	 */
	async listTracks(
		urlForTrack: (serverId: string) => string,
		urlForTrackImage: (serverId: string) => string,
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
						artists: track.artists,
						durationMs: track.duration,
						streamUrl: urlForTrack(track.id),
						coverUrl: track.coverUrl ? urlForTrackImage(track.id) : undefined,
					})),
				};
			}
			if (res.status === 401) this.expireSession();
			return failure(res, `Loading the track list failed (HTTP ${res.status})`);
		} catch {
			return { ok: false, error: "Loading the track list failed — server unreachable" };
		}
	}

	/**
	 * Server artist listing. `urlForArtistImage` maps an artist id to its
	 * stream-proxy avatar URL; the server only sends `imageUrl` (its own image
	 * route) for artists that actually have an image, so it stays undefined for
	 * the rest — the webview never reaches the backend directly.
	 */
	async listArtists(
		urlForArtistImage: (artistId: number) => string,
	): Promise<ListArtistsResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		try {
			const res = await client.getArtists();
			if (res.status === 200) {
				return {
					ok: true,
					artists: res.body.map(({ id, name, imageUrl }) => ({
						id,
						name,
						imageUrl: imageUrl ? urlForArtistImage(id) : undefined,
					})),
				};
			}
			if (res.status === 401) this.expireSession();
			return failure(
				res,
				`Loading the artist list failed (HTTP ${res.status})`,
			);
		} catch {
			return {
				ok: false,
				error: "Loading the artist list failed — server unreachable",
			};
		}
	}

	async createArtist(params: CreateArtistParams): Promise<RpcResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		try {
			const res = await client.postArtist({
				body: { name: params.name, image: params.imageBase64 },
			});
			if (res.status === 200) return { ok: true };
			if (res.status === 401) this.expireSession();
			return failure(
				res,
				`Creating the artist failed (HTTP ${res.status})`,
				"image",
			);
		} catch {
			return { ok: false, error: "Creating the artist failed — server unreachable" };
		}
	}

	async editArtist(params: EditArtistParams): Promise<RpcResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		try {
			const res = await client.editArtist({
				body: {
					id: params.id,
					name: params.name,
					// undefined drops off the wire (unchanged); null survives (remove).
					image: params.imageBase64,
				},
			});
			if (res.status === 200) return { ok: true };
			if (res.status === 401) this.expireSession();
			return failure(
				res,
				`Editing the artist failed (HTTP ${res.status})`,
				"image",
			);
		} catch {
			return { ok: false, error: "Editing the artist failed — server unreachable" };
		}
	}

	async deleteArtist(params: DeleteArtistParams): Promise<RpcResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		try {
			const res = await client.deleteArtist({ body: { id: params.id } });
			if (res.status === 200) return { ok: true };
			if (res.status === 401) this.expireSession();
			return failure(res, `Deleting the artist failed (HTTP ${res.status})`);
		} catch {
			return { ok: false, error: "Deleting the artist failed — server unreachable" };
		}
	}

	/**
	 * Server playlist listing. `urlForPlaylistImage` maps a playlist id to its
	 * stream-proxy cover URL; like `listArtists`, `imageUrl` stays undefined
	 * unless the server sent one — the webview never reaches the backend.
	 */
	async listPlaylists(
		urlForPlaylistImage: (playlistId: number) => string,
	): Promise<ListPlaylistsResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		try {
			const res = await client.getPlaylists();
			if (res.status === 200) {
				return {
					ok: true,
					playlists: res.body.map(({ id, name, trackIds, imageUrl }) => ({
						id,
						name,
						trackIds,
						imageUrl: imageUrl ? urlForPlaylistImage(id) : undefined,
					})),
				};
			}
			if (res.status === 401) this.expireSession();
			return failure(res, `Loading the playlists failed (HTTP ${res.status})`);
		} catch {
			return {
				ok: false,
				error: "Loading the playlists failed — server unreachable",
			};
		}
	}

	async createPlaylist(params: CreatePlaylistParams): Promise<RpcResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		try {
			const res = await client.postPlaylist({
				body: {
					name: params.name,
					trackIds: params.trackIds,
					image: params.imageBase64,
				},
			});
			if (res.status === 200) return { ok: true };
			if (res.status === 401) this.expireSession();
			return failure(
				res,
				`Creating the playlist failed (HTTP ${res.status})`,
				"image",
			);
		} catch {
			return { ok: false, error: "Creating the playlist failed — server unreachable" };
		}
	}

	async editPlaylist(params: EditPlaylistParams): Promise<RpcResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		try {
			const res = await client.editPlaylist({
				body: {
					id: params.id,
					name: params.name,
					trackIds: params.trackIds,
					// undefined drops off the wire (unchanged); null survives (remove).
					image: params.imageBase64,
				},
			});
			if (res.status === 200) return { ok: true };
			if (res.status === 401) this.expireSession();
			return failure(
				res,
				`Editing the playlist failed (HTTP ${res.status})`,
				"image",
			);
		} catch {
			return { ok: false, error: "Editing the playlist failed — server unreachable" };
		}
	}

	async deletePlaylist(params: DeletePlaylistParams): Promise<RpcResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		try {
			const res = await client.deletePlaylist({ body: { id: params.id } });
			if (res.status === 200) return { ok: true };
			if (res.status === 401) this.expireSession();
			return failure(res, `Deleting the playlist failed (HTTP ${res.status})`);
		} catch {
			return { ok: false, error: "Deleting the playlist failed — server unreachable" };
		}
	}
}

/**
 * Turns any non-200 response into the failure the webview reports.
 *
 * `413` and `429` are produced by the server's request pipeline rather than by
 * an endpoint, so every route can answer with them however its handler behaves —
 * which is why they are mapped here once instead of per call site. Everything
 * else keeps the server's own message, since only it knows what went wrong.
 *
 * `payload` names which ceiling a 413 hit, for routes that carry bytes.
 */
function failure(
	res: { status: number; body: unknown; headers: Headers },
	fallback: string,
	payload?: "audio" | "image",
): RpcFailure {
	if (res.status === 429) {
		const retryAfterSec = retryAfterSeconds(res.headers);
		return {
			ok: false,
			status: res.status,
			retryAfterSec,
			error:
				retryAfterSec === undefined
					? "Too many requests — please wait a moment and try again."
					: `Too many requests — try again in ${formatDelay(retryAfterSec)}.`,
		};
	}
	if (res.status === 413 && payload) {
		const limit = payload === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
		const what = payload === "audio" ? "track" : "image";
		// The webview refuses anything over the contract's ceilings before it is
		// encoded, so a 413 still arriving means this server holds a tighter line
		// than the contract does — which is why the message can't quote a ceiling
		// as *its* limit, and why the server's own message goes first. Ours names
		// only what this app allows, which stays true whatever the server's is.
		return {
			ok: false,
			status: res.status,
			error: errorText(
				res.body,
				`The server refused this ${what} as too large — this app allows up to ${megabytes(limit)}.`,
			),
		};
	}
	return { ok: false, status: res.status, error: errorText(res.body, fallback) };
}

/**
 * The wait a 429 asks for. The contract states `Retry-After` in seconds; an
 * HTTP-date (which the header also allows) yields no delay rather than a wrong
 * one — the caller then says "wait a moment" instead of naming a bogus number.
 */
function retryAfterSeconds(headers: Headers): number | undefined {
	const value = Number(headers.get("retry-after"));
	return Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

/** 45 → "45 seconds"; 900 → "15 minutes". */
function formatDelay(seconds: number): string {
	if (seconds < 60) {
		return `${seconds} second${seconds === 1 ? "" : "s"}`;
	}
	const minutes = Math.ceil(seconds / 60);
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * 78643200 → "75.0 MB". One decimal, matching how the webview states the same
 * ceilings — and a limit of 7.5 MiB rounded to whole megabytes would claim 8,
 * sending the user back with a file that fails again.
 */
function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorText(body: unknown, fallback: string): string {
	return typeof body === "string" && body.length > 0 ? body : fallback;
}
