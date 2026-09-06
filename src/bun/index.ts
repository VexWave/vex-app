import { BrowserView, BrowserWindow, Updater } from "electrobun/bun";
import { ApiClient } from "./ApiClient";
import { BinaryManager } from "./BinaryManager";
import { DiscordPresence } from "./DiscordPresence";
import { MediaSearch } from "./MediaSearch";
import { StreamProxy } from "./StreamProxy";
import { saveTrackToDisk } from "./TrackDownloader";
import { Uninstaller } from "./Uninstaller";
import { UrlImporter } from "./UrlImporter";
import { applyWindowChrome } from "./WindowChrome";
import type { PlayerRPC, RpcFailure } from "../shared/rpcSchema";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

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

const url = await getMainViewUrl();

const api = new ApiClient();
const streamProxy: StreamProxy = new StreamProxy(
	api,
	() => {
		api.expireSession();
		rpc.send.sessionExpired({
			reason: "Session expired — please log in again.",
		});
	},
	(importId) => importer.filePathFor(importId),
);

const binaryManager = new BinaryManager((msg) => rpc.send.binaryProgress(msg));
binaryManager.startUpdateCheckIfInstalled();

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

const QUIT_DELAY_MS = 500;

function ytDlpBusyReason(): string | null {
	if (importer.isActive) {
		return "A URL import is running — try again when it's done.";
	}
	if (mediaSearch.isActive) {
		return "A search is running — try again in a moment.";
	}
	return null;
}

function unlessInstalling<T>(run: () => T): T | RpcFailure {
	return binaryManager.isBusy
		? { ok: false, error: "Components are updating — try again in a moment." }
		: run();
}

const rpc = BrowserView.defineRPC<PlayerRPC>({
	// Electrobun's default is 1s; logins and multi-MB uploads need far more.
	maxRequestTime: 120_000,
	handlers: {
		requests: {
			login: (params) => api.login(params),
			restoreSession: (params) => api.restoreSession(params),
			logout: () => {
				api.expireSession();
				return { ok: true as const };
			},
			getLibrary: () => api.getLibrary(streamProxy),
			uploadTrack: (params) => api.uploadTrack(params),
			deleteTrack: async (params) => {
				const result = await api.deleteTrack(params);
				if (result.ok) streamProxy.evictTrack(params.id);
				return result;
			},
			downloadTrack: (params) =>
				saveTrackToDisk(
					streamProxy,
					params.id,
					params.fileName,
					params.startingFolder,
				),
			editTrack: (params) => api.editTrack(params),
			createArtist: (params) => api.createArtist(params),
			editArtist: (params) => api.editArtist(params),
			deleteArtist: (params) => api.deleteArtist(params),
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
			uninstallApp: async () => {
				const busy = ytDlpBusyReason();
				if (busy) return { ok: false as const, error: busy };
				return unlessInstalling(async () => {
					const result = await uninstaller.start();
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

applyWindowChrome(mainWindow, WINDOW_TITLE);

// Bundled CEF paints its first frame before it settles on the monitor scale, so
// HiDPI comes up zoomed and clipped until a resize forces the recompute.
// electrobun#324: the launcher declares no DPI awareness.
if (process.platform === "win32") {
	const nudge = () => {
		const { width, height } = mainWindow.getSize();
		mainWindow.setSize(width + 1, height);
		setTimeout(() => mainWindow.setSize(width, height), 50);
	};
	let domReady = false;
	mainWindow.webview.on("dom-ready", () => {
		if (domReady) return;
		domReady = true;
		setTimeout(nudge, 50);
	});
	setTimeout(() => {
		if (!domReady) nudge();
	}, 2000);
}

console.log("VexWave started!");
