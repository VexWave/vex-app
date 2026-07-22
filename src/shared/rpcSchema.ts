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

/**
 * Server ids of tracks whose complete audio sits in the bun-side memory cache
 * (StreamProxy/TrackCache) — the UI marks these as instant to play. Always the
 * full current set, never a delta, so a missed message can't leave the webview
 * permanently stale.
 */
export interface CachedTracks {
	trackIds: number[];
}

// --- Binary manager --------------------------------------------------------

/**
 * The managed external executables (downloaded at runtime, not bundled).
 * "ffmpeg" implicitly includes ffprobe — they install and report as one unit.
 */
export type BinaryName = "ytDlp" | "ffmpeg" | "deno";

export interface BinaryStatus {
	installed: BinaryName[];
	missing: BinaryName[];
	/** Manifest version tag of installed yt-dlp; absent when missing/unknown. */
	ytDlpVersion?: string;
}

export type BinaryStatusResult = ({ ok: true } & BinaryStatus) | RpcFailure;

/**
 * Never a failure shape: the update check is best-effort and fails silently
 * (offline / GitHub rate limit → `updateAvailable: false`).
 */
export interface YtDlpUpdateResult {
	ok: true;
	updateAvailable: boolean;
	/** Present only when `updateAvailable`. */
	latestVersion?: string;
	installedVersion?: string;
}

export type BinaryInstallStep = "downloading" | "extracting";

/**
 * Pushed by bun while an install/update run is active. The install requests
 * only *start* runs (a 100 MB download would blow `maxRequestTime`), so
 * completion also arrives here, as "finished" or "failed".
 */
export type BinaryProgressMessage =
	| {
			type: "progress";
			binary: BinaryName;
			step: BinaryInstallStep;
			receivedBytes: number;
			/** Absent when the server sent no content-length (indeterminate). */
			totalBytes?: number;
			/** 1-based; macOS ffmpeg is two downloads (ffmpeg + ffprobe). */
			part: number;
			partCount: number;
	  }
	| { type: "binaryInstalled"; binary: BinaryName }
	| { type: "finished" }
	| { type: "failed"; binary: BinaryName; error: string };

// --- URL import ------------------------------------------------------------

export interface ImportFromUrlParams {
	/**
	 * Webview-generated UUID for this import job. The webview picks the id so
	 * its pending row exists before the RPC even resolves — progress messages
	 * can never race ahead of an id handshake.
	 */
	importId: string;
	/** A YouTube or SoundCloud page URL (validated webview-side). */
	url: string;
}

export interface DiscardImportParams {
	importId: string;
}

export type UrlImportStep = "starting" | "downloading" | "converting";

/**
 * Pushed by bun while a URL import runs. Like binary installs, the
 * `importFromUrl` request only *starts* the job (a media download would blow
 * `maxRequestTime`), so completion also arrives here. On "finished" the webview
 * fetches the converted mp3 from `fileUrl` (a loopback StreamProxy URL) and
 * stages it through the normal upload-review flow, then discards the temp file.
 */
export type UrlImportProgressMessage =
	| {
			type: "progress";
			importId: string;
			step: UrlImportStep;
			/** Media title, present once yt-dlp has resolved the page metadata. */
			title?: string;
			receivedBytes?: number;
			/** Absent when yt-dlp doesn't know the download size (indeterminate). */
			totalBytes?: number;
	  }
	| {
			type: "finished";
			importId: string;
			/** Sanitized `<title>.mp3` — becomes the staged File's name. */
			fileName: string;
			/** Loopback URL serving the finished mp3 to the webview. */
			fileUrl: string;
	  }
	| { type: "failed"; importId: string; error: string };

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
			getBinaryStatus: { params: undefined; response: BinaryStatusResult };
			/**
			 * Kicks off an install of all missing binaries and returns
			 * immediately; progress and completion arrive as `binaryProgress`
			 * messages. No-op success while a run is already active.
			 */
			installMissingBinaries: { params: undefined; response: RpcResult };
			/** Forced re-download of yt-dlp only; same async machinery. */
			updateYtDlp: { params: undefined; response: RpcResult };
			checkYtDlpUpdate: { params: undefined; response: YtDlpUpdateResult };
			/**
			 * Queues a yt-dlp download of the URL and returns immediately;
			 * progress and completion arrive as `urlImportProgress` messages.
			 */
			importFromUrl: { params: ImportFromUrlParams; response: RpcResult };
			/** Deletes a finished import's temp mp3 once the webview has it. */
			discardImport: { params: DiscardImportParams; response: RpcResult };
			/**
			 * Current cache membership, for (re)hydrating the webview — e.g.
			 * after an HMR reload, which restarts the webview but not bun.
			 * Later changes arrive as `trackCacheChanged` messages.
			 */
			getCachedTracks: { params: undefined; response: CachedTracks };
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
			/** Progress/completion stream of a running binary install/update. */
			binaryProgress: BinaryProgressMessage;
			/** Progress/completion stream of running URL imports. */
			urlImportProgress: UrlImportProgressMessage;
			/** Pushed whenever the set of fully-cached tracks changes. */
			trackCacheChanged: CachedTracks;
		};
	}>;
};
