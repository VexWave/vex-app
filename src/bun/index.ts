import { BrowserView, BrowserWindow, Updater } from "electrobun/bun";
import { ApiClient } from "./ApiClient";
import { BinaryManager } from "./BinaryManager";
import { StreamProxy } from "./StreamProxy";
import { UrlImporter } from "./UrlImporter";
import type { PlayerRPC } from "../shared/rpcSchema";

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

const importer: UrlImporter = new UrlImporter(
	binaryManager,
	(msg) => rpc.send.urlImportProgress(msg),
	(importId) => streamProxy.urlForImportFile(importId),
);

const rpc = BrowserView.defineRPC<PlayerRPC>({
	// Default is 1s; logins and multi-MB uploads need far more.
	maxRequestTime: 120_000,
	handlers: {
		requests: {
			login: (params) => api.login(params),
			uploadTrack: (params) => api.uploadTrack(params),
			listTracks: () =>
				api.listTracks(
					(serverId) => streamProxy.urlForTrack(serverId),
					(serverId) => streamProxy.urlForTrackImage(serverId),
				),
			deleteTrack: (params) => api.deleteTrack(params),
			editTrack: (params) => api.editTrack(params),
			listArtists: () =>
				api.listArtists((artistId) => streamProxy.urlForArtistImage(artistId)),
			createArtist: (params) => api.createArtist(params),
			editArtist: (params) => api.editArtist(params),
			deleteArtist: (params) => api.deleteArtist(params),
			getBinaryStatus: () => binaryManager.getStatus(),
			installMissingBinaries: () => binaryManager.startInstall(),
			// A running yt-dlp.exe can't be overwritten on Windows, so the
			// updater and the importer mutually exclude each other.
			updateYtDlp: () =>
				importer.isActive
					? {
							ok: false as const,
							error: "A URL import is running — try again when it's done.",
						}
					: binaryManager.startYtDlpUpdate(),
			checkYtDlpUpdate: () => binaryManager.checkYtDlpUpdate(),
			importFromUrl: (params) =>
				binaryManager.isBusy
					? {
							ok: false as const,
							error: "Components are updating — try again in a moment.",
						}
					: importer.start(params),
			discardImport: (params) => importer.discard(params),
		},
	},
});

export const mainWindow = new BrowserWindow({
	title: "VexWave",
	url,
	frame: {
		width: 900,
		height: 700,
		x: 200,
		y: 200,
	},
	rpc,
});

console.log("VexWave started!");
