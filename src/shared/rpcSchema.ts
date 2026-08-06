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
 * Login hands the session token back to the webview so it can be persisted in
 * localStorage and replayed on the next startup (see `restoreSession`). This is
 * the one place the token crosses into the webview; every other server call
 * still runs bun-side with the token held in ApiClient.
 */
export type LoginResult = { ok: true; token: string } | RpcFailure;

/**
 * Re-establishes the bun-side session from a token the webview persisted, with
 * no re-authentication round-trip. The token isn't verified here — the first
 * authenticated call (library refresh) validates it and a 401 falls back to the
 * login screen.
 */
export interface RestoreSessionParams {
	host: string;
	port: number;
	token: string;
}

/**
 * Failed handler results cross the RPC boundary as plain values instead of
 * thrown errors so the HTTP status (401 detection) survives intact.
 */
export interface RpcFailure {
	ok: false;
	/** HTTP status when the server answered; absent on transport failures. */
	status?: number;
	/**
	 * Seconds the server asked the caller to wait before trying again, from the
	 * `Retry-After` of a 429. The contract requires clients to honour it rather
	 * than retrying immediately, so it travels with the failure instead of being
	 * flattened into the message.
	 */
	retryAfterSec?: number;
	error: string;
}

export type RpcResult = { ok: true } | RpcFailure;

export interface UploadTrackParams {
	title: string;
	/** Integer milliseconds; the webview converts the tag's float seconds once. */
	durationMs: number;
	/** Raw file bytes, base64-encoded. */
	dataBase64: string;
	/** Raw cover-image bytes, base64-encoded. Omit for no cover. */
	coverBase64?: string;
	/** Artist ids to link to the track (empty/omitted → none). */
	artistIds?: number[];
}

export interface RemoteTrack {
	/** Server-side track id (a uuid — it says nothing about upload order). */
	id: string;
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

/** Oldest first, as the server sends it — the only record of upload order. */
export type ListTracksResult = { ok: true; tracks: RemoteTrack[] } | RpcFailure;

export interface DeleteTrackParams {
	/** Server-side track id. */
	id: string;
}

export interface EditTrackParams {
	/** Server-side track id. */
	id: string;
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

export interface CreatePlaylistParams {
	name: string;
	/** Initial ordered playback list; a track at most once. Omit for empty. */
	trackIds?: string[];
	/** Raw cover-image bytes, base64-encoded. Omit for no cover. */
	imageBase64?: string;
}

export interface EditPlaylistParams {
	/** Server-side playlist id. */
	id: number;
	name?: string;
	/**
	 * Full replacement of the ordered track list (empty array clears it);
	 * omit to leave it unchanged. A track may appear at most once — the
	 * server rejects duplicates.
	 */
	trackIds?: string[];
	/** New cover bytes, base64; `null` removes the cover; omit = unchanged. */
	imageBase64?: string | null;
}

export interface DeletePlaylistParams {
	/** Server-side playlist id. */
	id: number;
}

export interface RemotePlaylist {
	/** Server-side playlist id. */
	id: number;
	name: string;
	/**
	 * Ordered playback list of server track ids; each id appears at most
	 * once. The server drops deleted tracks from playlists, so every id here
	 * should exist in the track listing (a stale one is skipped by the
	 * client-side join).
	 */
	trackIds: string[];
	/**
	 * Loopback URL of the bun-side stream proxy for this playlist's cover, or
	 * undefined when the playlist has none. Same pattern as
	 * `RemoteArtist.imageUrl`: the webview loads it directly and never reaches
	 * the backend.
	 */
	imageUrl?: string;
}

export type ListPlaylistsResult =
	| { ok: true; playlists: RemotePlaylist[] }
	| RpcFailure;

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
 * The creator an import resolved (YouTube channel / SoundCloud uploader), which
 * the upload-review dialog proposes as an artist to link. The image is the
 * creator's YouTube channel avatar when a best-effort second yt-dlp lookup found
 * one — SoundCloud imports never carry one. Avatars are small, so the bytes ride
 * the message as base64 rather than through a proxy URL.
 */
export interface ImportedArtist {
	name: string;
	imageBase64?: string;
	imageMime?: string;
}

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
			/** Absent when yt-dlp resolved no creator at all. */
			artist?: ImportedArtist;
	  }
	| { type: "failed"; importId: string; error: string };

// --- Discover search -------------------------------------------------------

/** The platforms yt-dlp can search for the Discover view. */
export type SearchSource = "youtube" | "soundcloud";

export interface SearchMediaParams {
	query: string;
	source: SearchSource;
}

/** One hit of a Discover search — everything a result card draws, and the URL
 * that downloads it. */
export interface MediaSearchResult {
	/** Source-qualified media id; unique per search, so it keys the result list. */
	id: string;
	title: string;
	/** The media's page URL, handed straight back to `importFromUrl`. */
	url: string;
	/** Publishing creator, absent when the platform names none. */
	artist?: string;
	/** Whole seconds; absent for live streams and unknown lengths. */
	durationSec?: number;
	/**
	 * The platform's own thumbnail URL, loaded directly by the webview's <img>.
	 * Unlike backend payloads this needs no proxy: it carries no session token,
	 * gives away nothing about the backend, and the search that produced it has
	 * already contacted the platform.
	 */
	thumbnailUrl?: string;
}

export type SearchMediaResult =
	| { ok: true; results: MediaSearchResult[] }
	| RpcFailure;

// --- Discord Rich Presence -------------------------------------------------

/**
 * The track the Discord presence should advertise, or `null` to take it down.
 * Only the pieces Discord itself renders travel here — the cover is named by
 * track id rather than by URL, because the webview's cover URLs all point at
 * the loopback stream proxy and Discord fetches activity images from its own
 * servers. Bun holds the backend's real address and builds the public URL.
 *
 * A track here is always one that is *playing*: there is no paused presence and
 * no idle one, so pausing arrives as `null` and resuming as the track again.
 * Nothing carries a play/pause flag because there is no state it could describe.
 */
export interface PresenceTrack {
	/** Server-side track id, which is also what the cover route is keyed by. */
	id: string;
	title: string;
	/** Joined artist names; absent when the track has none. */
	artist?: string;
	/** Whether the server holds a cover for this track. */
	hasCover: boolean;
	/** Playback position, which anchors Discord's progress bar. */
	positionSec: number;
	/** 0 while still unknown — Discord then shows elapsed time, not a bar. */
	durationSec: number;
}

export interface PresenceMessage {
	track: PresenceTrack | null;
}

/**
 * Whether the integration runs at all. The setting is the webview's — it is a
 * user preference, and localStorage is the app's only persistence — so bun holds
 * no default and no copy of its own, and is told where it stands by every
 * webview that starts.
 */
export interface SetPresenceEnabledParams {
	enabled: boolean;
}

/**
 * Whether a Discord client is answering right now, which is what the settings
 * panel reports. Connected says the IPC socket is up, not that a card is
 * showing: there is no card unless something is playing.
 *
 * Both the answer to `setPresenceEnabled` and what bun pushes when this changes
 * without being asked — they are the same fact, so they are the same shape.
 */
export interface PresenceStatus {
	connected: boolean;
}

export type PlayerRPC = {
	bun: RPCSchema<{
		requests: {
			login: { params: LoginParams; response: LoginResult };
			/**
			 * Restores a bun-side session from a persisted token (no re-auth).
			 * Always succeeds unless the RPC transport fails; token validity is
			 * checked lazily by the first authenticated call.
			 */
			restoreSession: { params: RestoreSessionParams; response: RpcResult };
			/** Drops the bun-side session (token + client); no server call. */
			logout: { params: undefined; response: RpcResult };
			uploadTrack: { params: UploadTrackParams; response: RpcResult };
			deleteTrack: { params: DeleteTrackParams; response: RpcResult };
			editTrack: { params: EditTrackParams; response: RpcResult };
			listTracks: { params: undefined; response: ListTracksResult };
			listArtists: { params: undefined; response: ListArtistsResult };
			createArtist: { params: CreateArtistParams; response: RpcResult };
			editArtist: { params: EditArtistParams; response: RpcResult };
			deleteArtist: { params: DeleteArtistParams; response: RpcResult };
			listPlaylists: { params: undefined; response: ListPlaylistsResult };
			createPlaylist: { params: CreatePlaylistParams; response: RpcResult };
			editPlaylist: { params: EditPlaylistParams; response: RpcResult };
			deletePlaylist: { params: DeletePlaylistParams; response: RpcResult };
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
			 * One page of search hits for the Discover view. Unlike an import this
			 * answers inside the request: it is a single metadata call, no media
			 * is downloaded. A newer search supersedes an unanswered one, which
			 * then fails rather than resolving with results nobody asked for.
			 */
			searchMedia: { params: SearchMediaParams; response: SearchMediaResult };
			/**
			 * Switches the Discord presence on or off, and answers with where the
			 * connection stands. A request rather than a message because this is
			 * the one thing about the presence that can't put itself right later:
			 * a track update that goes missing is corrected by the next one, while
			 * a setting that goes missing leaves bun disagreeing with the switch
			 * until the user touches it again. Nothing can fail here, so the answer
			 * carries no failure shape — only the state it left behind.
			 */
			setPresenceEnabled: {
				params: SetPresenceEnabledParams;
				response: PresenceStatus;
			};
		};
		messages: {
			/**
			 * Pushed by the webview whenever what Discord should display changes
			 * — a different track, play/pause, a seek. A message rather than a
			 * request because nothing comes back and nothing waits on it: the
			 * presence is decoration, and a dropped update is corrected by the
			 * next one. The webview filters out no-op changes so this doesn't
			 * fire on every timeupdate.
			 */
			presenceChanged: PresenceMessage;
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
			/**
			 * Discord answering, or going away, with nobody having asked — the
			 * changes that happen on Discord's schedule rather than the user's.
			 * What a switch does is answered by `setPresenceEnabled` itself.
			 */
			presenceStatus: PresenceStatus;
		};
	}>;
};
