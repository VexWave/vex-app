import { Electroview } from "electrobun/view";
import type { PlayerRPC } from "../../shared/rpcSchema";

const rpc = Electroview.defineRPC<PlayerRPC>({
	// Default is 1s; logins and multi-MB uploads need far more.
	maxRequestTime: 120_000,
	handlers: {},
});

new Electroview({ rpc });

/** Typed requests handled by the bun process: `bun.login(...)`, `bun.uploadTrack(...)`. */
export const bun = rpc.request;

/** Listen for messages pushed by the bun process (e.g. `sessionExpired`). */
export const onBunMessage = rpc.addMessageListener;

/**
 * Push a fire-and-forget message to the bun process (e.g. `presenceChanged`).
 * Nothing comes back — use `bun.…` when the answer matters.
 */
export const notifyBun = rpc.send;
