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
