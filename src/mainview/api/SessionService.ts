import { storage } from "@/lib/storage";
import { bun, onBunMessage } from "./rpc";

export type SessionStatus = "loggedOut" | "loggingIn" | "loggedIn";

/**
 * Normalizes a typed server address into the base URL every contract path hangs
 * off; null when it isn't one.
 *
 * The scheme has to be typed: whether the server speaks TLS isn't knowable here,
 * and a wrong guess reports as "cannot reach", sending the user to look at their
 * server rather than at the address. A path survives for a backend behind a
 * reverse proxy, its trailing slash does not, and a query, a fragment and
 * credentials are no part of where the server is.
 */
export function parseServerUrl(raw: string): string | null {
	const input = raw.trim();
	if (!/^https?:\/\//i.test(input)) return null;
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return null;
	}
	// WHATWG rejects a port above 65535 but takes 0, which no server listens on.
	if (url.port === "0") return null;
	return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Immutable snapshot of the server session, consumed by the React layer. */
export interface SessionState {
	status: SessionStatus;
	error: string | null;
	/** Last successfully used server address, prefilled into the login form. */
	lastServerUrl: string;
	/**
	 * True while a persisted token is being replayed on startup — the app shows
	 * a splash instead of the login form so a valid token doesn't flash it.
	 */
	restoring: boolean;
	/**
	 * When the server's login throttle lets the next attempt through, as an
	 * epoch timestamp; null when nothing is holding attempts back. A deadline
	 * rather than a remaining duration: the form counts down against it once a
	 * second, and a duration would have to be re-based on every tick.
	 *
	 * Only held in memory — the server owns the real budget. This keeps the app
	 * from spending it against a wall the server already said no at.
	 */
	retryAfter: number | null;
}

/**
 * Tracks whether the user is logged in to a server. The session token is
 * persisted in localStorage so the login survives a restart: on startup the
 * stored token is replayed into the bun process (`restoreSession`), and every
 * server call still runs bun-side with the token held in ApiClient. Only the
 * token and the server's address are remembered — never the password.
 */
export class SessionService {
	private subscribers = new Set<() => void>();
	private snapshot: SessionState;

	constructor() {
		const baseUrl = storage.session.url.get() ?? "";
		const token = storage.session.token.get() ?? "";
		this.snapshot = {
			status: "loggedOut",
			error: null,
			lastServerUrl: baseUrl,
			// A silent restore takes every piece of a session being stored.
			restoring: !!baseUrl && !!token,
			retryAfter: null,
		};
		if (this.snapshot.restoring) void this.restore(baseUrl, token);
	}

	/**
	 * Replays a persisted token into the bun process on startup. The token isn't
	 * verified here — the library refresh that fires on `loggedIn` validates it,
	 * and a 401 there clears the token and drops back to the login screen.
	 */
	private async restore(baseUrl: string, token: string): Promise<void> {
		try {
			const result = await bun.restoreSession({ baseUrl, token });
			if (result.ok) {
				this.update({ status: "loggedIn", restoring: false });
				return;
			}
		} catch {
			// RPC transport failure — fall through to the login screen.
		}
		this.clearStoredToken();
		this.update({ status: "loggedOut", restoring: false });
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): SessionState => this.snapshot;

	/** `baseUrl` is a `parseServerUrl` result — the form normalizes before it asks. */
	async login(
		baseUrl: string,
		username: string,
		password: string,
	): Promise<void> {
		if (this.snapshot.status === "loggingIn") return;
		// The contract requires waiting out a 429 rather than retrying into it.
		// The button is disabled meanwhile, but Enter reaches this path too.
		if (this.snapshot.retryAfter !== null && Date.now() < this.snapshot.retryAfter) {
			return;
		}
		this.update({ status: "loggingIn", error: null, retryAfter: null });
		let result;
		try {
			result = await bun.login({ baseUrl, username, password });
		} catch (err) {
			// RPC transport failure or timeout (e.g. bun process unreachable).
			this.update({
				status: "loggedOut",
				error: err instanceof Error ? err.message : "Login request failed",
			});
			return;
		}
		if (result.ok) {
			storage.session.url.set(baseUrl);
			// Persist the token so the session survives a restart (see restore()).
			storage.session.token.set(result.token);
			this.update({ status: "loggedIn", lastServerUrl: baseUrl });
		} else {
			this.update({
				status: "loggedOut",
				error: result.error,
				retryAfter:
					result.retryAfterSec === undefined
						? null
						: Date.now() + result.retryAfterSec * 1000,
			});
		}
	}

	/**
	 * Signs out locally: forgets the token here and bun-side, then returns to the
	 * login screen. The server token isn't revoked — this only drops our copy.
	 */
	async logout(): Promise<void> {
		this.clearStoredToken();
		try {
			await bun.logout();
		} catch {
			// Best-effort; the webview state below is what gates the UI.
		}
		this.update({ status: "loggedOut", error: null });
	}

	/** Drops back to the login screen, e.g. when an upload hits a 401. */
	markExpired(message: string): void {
		// The token is dead — drop the persisted copy so the next startup doesn't
		// replay it straight into another expiry.
		this.clearStoredToken();
		this.update({ status: "loggedOut", error: message });
	}

	private clearStoredToken(): void {
		storage.session.token.remove();
	}

	private update(patch: Partial<SessionState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — session state must survive component unmounts. */
export const sessionService = new SessionService();

// The stream proxy is the one server path that bypasses RPC requests, so a
// token rejected mid-stream reaches the webview as a pushed message instead
// of a 401 result.
onBunMessage("sessionExpired", ({ reason }) => {
	sessionService.markExpired(reason);
});
