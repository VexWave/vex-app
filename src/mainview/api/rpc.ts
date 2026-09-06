import { Electroview } from "electrobun/view";
import type { PlayerRPC } from "../../shared/rpcSchema";

const rpc = Electroview.defineRPC<PlayerRPC>({
	// Electrobun's default is 1s; logins and multi-MB uploads need far more.
	maxRequestTime: 120_000,
	handlers: {},
});

new Electroview({ rpc });

export const bun = rpc.request;

export const onBunMessage = rpc.addMessageListener;

export const notifyBun = rpc.send;
