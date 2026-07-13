import { BrowserView, BrowserWindow, Updater } from "electrobun/bun";
import { ApiClient } from "./ApiClient";
import { StreamProxy } from "./StreamProxy";
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
const streamProxy = new StreamProxy(api, () => {
	api.expireSession();
	rpc.send.sessionExpired({
		reason: "Session expired — please log in again.",
	});
});

const rpc = BrowserView.defineRPC<PlayerRPC>({
	// Default is 1s; logins and multi-MB uploads need far more.
	maxRequestTime: 120_000,
	handlers: {
		requests: {
			login: (params) => api.login(params),
			uploadTrack: (params) => api.uploadTrack(params),
			listTracks: () =>
				api.listTracks((serverId) => streamProxy.urlForTrack(serverId)),
		},
	},
});

export const mainWindow = new BrowserWindow({
	title: "Music Player",
	url,
	frame: {
		width: 900,
		height: 700,
		x: 200,
		y: 200,
	},
	rpc,
});

console.log("React Tailwind Vite app started!");
