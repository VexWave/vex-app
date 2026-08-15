import { BrowserView, BrowserWindow, Updater } from "electrobun/bun";
import { ApiClient } from "./ApiClient";
import { BinaryManager } from "./BinaryManager";
import { DiscordPresence } from "./DiscordPresence";
import { MediaSearch } from "./MediaSearch";
import { StreamProxy } from "./StreamProxy";
import { Uninstaller } from "./Uninstaller";
import { UrlImporter } from "./UrlImporter";
import { applyWindowChrome } from "./WindowChrome";
import type { PlayerRPC, RpcFailure } from "../shared/rpcSchema";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

// Check if Vite dev server is running for HMR
async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
			return DEV_SERVER_URL;
		} catch {
			console.log(
				"Vite dev server not running. Run 'bun run dev:hmr' for HMR support.",
			);
		}
	}
	return "views://mainview/index.html";
}

// Create the main application window
const url = await getMainViewUrl();

const api = new ApiClient();
// A 401 on a stream request means the token is dead: drop it bun-side and
// push the expiry to the webview (media errors carry no HTTP status, so the
// webview can't detect this itself). `rpc` is initialized below; streams
// can't run before it exists because logging in requires the RPC.
// Explicit types break the streamProxy ↔ importer inference cycle (each one's
// constructor closes over the other).
const streamProxy: StreamProxy = new StreamProxy(
	api,
	() => {
		api.expireSession();
		rpc.send.sessionExpired({
			reason: "Session expired — please log in again.",
		});
	},
	// Forward reference: import files are only requested after an import
	// finished, so `importer` exists long before this resolver ever runs.
	(importId) => importer.filePathFor(importId),
);

// Same forward-reference pattern as StreamProxy: progress messages only flow
// after the webview kicks off an install over RPC, so `rpc` exists by then.
const binaryManager = new BinaryManager((msg) => rpc.send.binaryProgress(msg));
binaryManager.startUpdateCheckIfInstalled();

// Cover URLs are built against the live backend address: Discord fetches
// activity images from its own servers, so it needs the backend's real
// (public) URL rather than the loopback proxy one the webview uses.
//
// Nothing starts it here: the webview owns the setting and switches it on. The
// forward reference to `rpc` is the same pattern as elsewhere — an unasked-for
// status can only follow a connection the webview asked for.
const discordPresence = new DiscordPresence(
	() => api.auth?.baseUrl ?? null,
	(status) => rpc.send.presenceStatus(status),
);

const importer: UrlImporter = new UrlImporter(
	binaryManager,
	(msg) => rpc.send.urlImportProgress(msg),
	(importId) => streamProxy.urlForImportFile(importId),
);

const mediaSearch = new MediaSearch(binaryManager);

const uninstaller = new Uninstaller(
	binaryManager.isSupported ? binaryManager.binDir : null,
);

/** How long the uninstall's answer has to reach the webview before the app goes. */
const QUIT_DELAY_MS = 500;

/**
 * Why the yt-dlp updater can't run, or null when it can. Windows refuses to
 * overwrite a running exe, so the updater excludes every spawner of it — this is
 * the one place that knows the full set, and a new spawner belongs here.
 */
function ytDlpBusyReason(): string | null {
	if (importer.isActive) {
		return "A URL import is running — try again when it's done.";
	}
	if (mediaSearch.isActive) {
		return "A search is running — try again in a moment.";
	}
	return null;
}

/** The other direction of the same exclusion: nothing may spawn yt-dlp while
 * the binaries are being replaced on disk. */
function unlessInstalling<T>(run: () => T): T | RpcFailure {
	return binaryManager.isBusy
		? { ok: false, error: "Components are updating — try again in a moment." }
		: run();
}

const rpc = BrowserView.defineRPC<PlayerRPC>({
	// Default is 1s; logins and multi-MB uploads need far more.
	maxRequestTime: 120_000,
	handlers: {
		requests: {
			login: (params) => api.login(params),
			restoreSession: (params) => api.restoreSession(params),
			// Local sign-out: forget the session bun-side. The server token isn't
			// revoked (the webview just drops its persisted copy); the cache is
			// left intact so re-logging in with the same token keeps its downloads
			// (StreamProxy wipes it only on an auth-key change).
			logout: () => {
				api.expireSession();
				return { ok: true as const };
			},
			uploadTrack: (params) => api.uploadTrack(params),
			listTracks: () =>
				api.listTracks(
					(serverId) => streamProxy.urlForTrack(serverId),
					(serverId, version) =>
						streamProxy.urlForTrackImage(serverId, version),
				),
			deleteTrack: async (params) => {
				const result = await api.deleteTrack(params);
				if (result.ok) streamProxy.evictTrack(params.id);
				return result;
			},
			editTrack: (params) => api.editTrack(params),
			listArtists: () =>
				api.listArtists((artistId, version) =>
					streamProxy.urlForArtistImage(artistId, version),
				),
			createArtist: (params) => api.createArtist(params),
			editArtist: (params) => api.editArtist(params),
			deleteArtist: (params) => api.deleteArtist(params),
			listPlaylists: () =>
				api.listPlaylists((playlistId, version) =>
					streamProxy.urlForPlaylistImage(playlistId, version),
				),
			createPlaylist: (params) => api.createPlaylist(params),
			editPlaylist: (params) => api.editPlaylist(params),
			deletePlaylist: (params) => api.deletePlaylist(params),
			getBinaryStatus: () => binaryManager.getStatus(),
			installMissingBinaries: () => binaryManager.startInstall(),
			updateYtDlp: () => {
				const busy = ytDlpBusyReason();
				return busy
					? { ok: false as const, error: busy }
					: binaryManager.startYtDlpUpdate();
			},
			checkYtDlpUpdate: () => binaryManager.checkYtDlpUpdate(),
			importFromUrl: (params) => unlessInstalling(() => importer.start(params)),
			discardImport: (params) => importer.discard(params),
			searchMedia: (params) => unlessInstalling(() => mediaSearch.run(params)),
			setPresenceEnabled: ({ enabled }) => discordPresence.setEnabled(enabled),
			canUninstall: async () => ({ removable: await uninstaller.removable() }),
			// The same exclusions the yt-dlp updater answers to, for the same
			// reason turned up: a spawned yt-dlp holds open an executable inside
			// one of the directories about to be removed.
			uninstallApp: async () => {
				const busy = ytDlpBusyReason();
				if (busy) return { ok: false as const, error: busy };
				return unlessInstalling(async () => {
					const result = await uninstaller.start();
					// The helper can only finish once this process releases its own
					// files, so going down is part of the uninstall rather than what
					// follows it. Delayed just long enough for the answer above to
					// reach the webview.
					//
					// Exiting outright rather than through `app.quit()`, which spends
					// five seconds waiting on a shutdown that has nothing left to do:
					// every window and every file here is about to be deleted, and the
					// helper stops whatever this leaves behind.
					if (result.ok) setTimeout(() => process.exit(0), QUIT_DELAY_MS);
					return result;
				});
			},
		},
		messages: {
			presenceChanged: ({ track }) => discordPresence.setNowPlaying(track),
		},
	},
});

const initialFrame = {
	width: 1200,
	height: 800,
	x: 200,
	y: 200,
};

const WINDOW_TITLE = "VexWave";

export const mainWindow = new BrowserWindow({
	title: WINDOW_TITLE,
	url,
	frame: initialFrame,
	rpc,
});

// Dark title bar + window icon on Windows; both are outside Electrobun's API.
applyWindowChrome(mainWindow, WINDOW_TITLE);

// Windows + bundled CEF paints its first frame before CEF has settled on the
// monitor's device scale factor, so on HiDPI displays (scaling != 100%) the
// initial layout is "zoomed in" with the window edges clipped until the first
// manual resize forces CEF to recompute its scale against the real client rect.
// Nudge the window size by 1px and back to trigger that recompute before the
// user sees it. Timed off the webview's dom-ready (the page's load event, i.e.
// CEF is actually rendering) rather than a fixed delay — on slow starts a
// timer fires before CEF is up and the nudge does nothing. See the DPI gotcha
// in CLAUDE.md and electrobun issue #324 (launcher doesn't declare DPI
// awareness).
if (process.platform === "win32") {
	const nudge = () => {
		const { width, height } = mainWindow.getSize();
		mainWindow.setSize(width + 1, height);
		setTimeout(() => mainWindow.setSize(width, height), 50);
	};
	let domReady = false;
	mainWindow.webview.on("dom-ready", () => {
		if (domReady) return; // re-emitted on full reloads (dev HMR)
		domReady = true;
		setTimeout(nudge, 50);
	});
	// Safety net if dom-ready never arrives (e.g. the page failed to load and
	// gets fixed later); skipped once the event has done the real nudge.
	setTimeout(() => {
		if (!domReady) nudge();
	}, 2000);
}

console.log("VexWave started!");
