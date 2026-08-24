import type { RpcFailure } from "../../shared/rpcSchema";
import { sessionService } from "./SessionService";

export type MutationResult = { ok: true } | { ok: false; error: string };

/**
 * One server write reduced to an error string. A 401 drops the app to the
 * login screen on the way past; `fallback` speaks when the RPC threw and there
 * is no server message to quote.
 */
export async function mutate(
	send: () => Promise<{ ok: true } | RpcFailure>,
	fallback: string,
): Promise<MutationResult> {
	let result;
	try {
		result = await send();
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : fallback };
	}
	if (result.ok) return { ok: true };
	if (result.status === 401) {
		sessionService.markExpired("Session expired — please log in again.");
	}
	return { ok: false, error: result.error };
}
