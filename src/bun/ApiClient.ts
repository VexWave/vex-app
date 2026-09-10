import { initClient, tsRestFetchApi } from "@ts-rest/core";
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
import { imageVersion } from "./imageVersion";
import type {
	CreateArtistParams,
	CreatePlaylistParams,
	DeleteArtistParams,
	DeletePlaylistParams,
	DeleteTrackParams,
	EditArtistParams,
	EditPlaylistParams,
	EditTrackParams,
	GetLibraryResult,
	LoginParams,
	LoginResult,
	ProxyParams,
	RestoreSessionParams,
	RpcFailure,
	RpcResult,
	UploadTrackParams,
} from "../shared/rpcSchema";

export interface ProxyUrls {
	urlForTrack(id: string): string;
	urlForTrackImage(id: string, version?: string): string;
	urlForArtistImage(id: number, version?: string): string;
	urlForPlaylistImage(id: number, version?: string): string;
}

if (
	base64Length(MAX_AUDIO_BYTES) > MAX_AUDIO_BASE64 ||
	base64Length(MAX_IMAGE_BYTES) > MAX_IMAGE_BASE64
) {
	throw new Error(
		"src/shared/limits.ts exceeds the contract's base64 caps — the two have to move together.",
	);
}

function createClient(baseUrl: string, token?: string, proxy?: string) {
	return initClient(ApiContract, {
		baseUrl,
		baseHeaders: token ? { authorization: token } : {},
		api: (args) => {
			const fetchOptions: BunFetchRequestInit = {
				...args.fetchOptions,
				proxy,
			};
			return tsRestFetchApi({ ...args, fetchOptions });
		},
	});
}

export interface BackendRoute {
	baseUrl: string;
	token: string;
	proxy?: string;
}

export function fetchBackend(
	route: BackendRoute,
	path: string,
	init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
	return fetch(route.baseUrl + path, {
		headers: { authorization: route.token, ...init.headers },
		proxy: route.proxy,
		signal: init.signal,
	});
}

// Under the RPC's 120 s maxRequestTime, or the webview gives up while bun still adopts.
const PROBE_TIMEOUT_MS = 30_000;

export class ApiClient {
	private session: {
		baseUrl: string;
		token: string;
		client: ReturnType<typeof createClient>;
	} | null = null;
	private proxyUrl: string | undefined;

	get proxy(): string | undefined {
		return this.proxyUrl;
	}

	get auth(): BackendRoute | null {
		if (!this.session) return null;
		const { baseUrl, token } = this.session;
		return { baseUrl, token, proxy: this.proxyUrl };
	}

	expireSession(): void {
		this.session = null;
	}

	restoreSession(params: RestoreSessionParams): RpcResult {
		const { baseUrl, token, proxyUrl } = params;
		this.proxyUrl = proxyUrl;
		this.session = { baseUrl, token, client: createClient(baseUrl, token, proxyUrl) };
		return { ok: true };
	}

	async login(params: LoginParams): Promise<LoginResult> {
		const { baseUrl, username, password, proxyUrl } = params;
		this.expireSession();
		try {
			const res = await createClient(baseUrl, undefined, proxyUrl).login({
				body: { username, password },
			});
			if (res.status === 200) {
				const token = res.body.token;
				this.proxyUrl = proxyUrl;
				this.session = { baseUrl, token, client: createClient(baseUrl, token, proxyUrl) };
				return { ok: true, token };
			}
			return failure(res, `Login failed (HTTP ${res.status})`);
		} catch (err) {
			return { ok: false, error: unreachable(baseUrl, err, proxyUrl) };
		}
	}

	async setProxy(params: ProxyParams): Promise<RpcResult> {
		const session = this.session;
		if (!session) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		const { baseUrl, token } = session;
		const { proxyUrl } = params;
		let res: Response;
		try {
			res = await fetchBackend(
				{ baseUrl, token, proxy: proxyUrl },
				ApiContract.getData.path,
				{ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
			);
		} catch (err) {
			return { ok: false, error: unreachable(baseUrl, err, proxyUrl) };
		}
		if (session !== this.session) {
			void res.body?.cancel();
			return { ok: false, error: "The session changed while checking the proxy." };
		}
		if (res.status === 200) {
			void res.body?.cancel();
			this.proxyUrl = proxyUrl;
			session.client = createClient(baseUrl, token, proxyUrl);
			return { ok: true };
		}
		if (res.status === 401) this.expireSession();
		const body = await res.text().catch(() => "");
		return failure(
			{ status: res.status, headers: res.headers, body },
			`Checking the proxy failed (HTTP ${res.status})`,
		);
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

	async getLibrary(urls: ProxyUrls): Promise<GetLibraryResult> {
		const client = this.session?.client;
		if (!client) {
			return { ok: false, status: 401, error: "Not logged in" };
		}
		try {
			const res = await client.getData();
			if (res.status === 200) {
				const { tracks, artists, playlists } = res.body;
				return {
					ok: true,
					tracks: tracks.map((track) => ({
						id: track.id,
						title: track.title,
						artistIds: track.artistIds,
						durationMs: track.duration,
						streamUrl: urls.urlForTrack(track.id),
						coverUrl: track.coverUrl
							? urls.urlForTrackImage(track.id, imageVersion(track.coverUrl))
							: undefined,
					})),
					artists: artists.map(({ id, name, imageUrl }) => ({
						id,
						name,
						imageUrl: imageUrl
							? urls.urlForArtistImage(id, imageVersion(imageUrl))
							: undefined,
					})),
					playlists: playlists.map(({ id, name, trackIds, imageUrl }) => ({
						id,
						name,
						trackIds,
						imageUrl: imageUrl
							? urls.urlForPlaylistImage(id, imageVersion(imageUrl))
							: undefined,
					})),
				};
			}
			if (res.status === 401) this.expireSession();
			return failure(res, `Loading the library failed (HTTP ${res.status})`);
		} catch {
			return {
				ok: false,
				error: "Loading the library failed — server unreachable",
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

function unreachable(baseUrl: string, err: unknown, proxy?: string): string {
	const code = (err as { code?: unknown })?.code;
	const detail = `${typeof code === "string" ? code : ""} ${
		err instanceof Error ? err.message : ""
	}`;
	const certRejected = /cert|ssl|tls/i.test(detail);
	if (!proxy) {
		return certRejected
			? `Cannot reach ${baseUrl} — its certificate was rejected.`
			: `Cannot reach ${baseUrl} — is the server running?`;
	}
	const via = `${baseUrl} through the proxy at ${URL.parse(proxy)?.host ?? "the given address"}`;
	return certRejected
		? `Cannot reach ${via} — the server's or the proxy's certificate was rejected.`
		: `Cannot reach ${via} — check its address and credentials.`;
}

type ErrorResponse = { status: number; body: unknown; headers: Headers };

function failure(
	res: ErrorResponse,
	fallback: string,
	payload?: "audio" | "image",
): RpcFailure {
	if (res.status === 407) {
		return {
			ok: false,
			status: res.status,
			error: "The proxy rejected its credentials.",
		};
	}
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
		return {
			ok: false,
			status: res.status,
			error: errorText(
				res,
				`The server refused this ${what} as too large — this app allows up to ${megabytes(limit)}.`,
			),
		};
	}
	return { ok: false, status: res.status, error: errorText(res, fallback) };
}

function retryAfterSeconds(headers: Headers): number | undefined {
	const value = Number(headers.get("retry-after"));
	return Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

function formatDelay(seconds: number): string {
	if (seconds < 60) {
		return `${seconds} second${seconds === 1 ? "" : "s"}`;
	}
	const minutes = Math.ceil(seconds / 60);
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The backend's own messages are text/plain; proxies in the way answer with HTML pages.
function errorText(res: ErrorResponse, fallback: string): string {
	const plain = res.headers.get("content-type")?.startsWith("text/plain");
	return plain && typeof res.body === "string" && res.body.length > 0
		? res.body
		: fallback;
}
