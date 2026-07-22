import { bun, onBunMessage } from "./rpc";

export type SessionStatus = "loggedOut" | "loggingIn" | "loggedIn";

/** Immutable snapshot of the server session, consumed by the React layer. */
export interface SessionState {
	status: SessionStatus;
	error: string | null;
	/** Last successfully used server address, prefilled into the login form. */
	lastHost: string;
	lastPort: string;
	/**
	 * True while a persisted token is being replayed on startup — the app shows
	 * a splash instead of the login form so a valid token doesn't flash it.
	 */
	restoring: boolean;
}

const HOST_KEY = "player.server.host";
const PORT_KEY = "player.server.port";
const TOKEN_KEY = "player.server.token";

/**
 * Tracks whether the user is logged in to a server. The session token is
 * persisted in localStorage so the login survives a restart: on startup the
 * stored token is replayed into the bun process (`restoreSession`), and every
 * server call still runs bun-side with the token held in ApiClient. Only the
 * token and host/port are remembered — never the password.
 */
export class SessionService {
	private subscribers = new Set<() => void>();
	private snapshot: SessionState = {
		status: "loggedOut",
		error: null,
		lastHost: localStorage.getItem(HOST_KEY) ?? "",
		lastPort: localStorage.getItem(PORT_KEY) ?? "",
		// Attempt a silent restore whenever every piece of a session is stored.
		restoring: hasStoredSession(),
	};

	constructor() {
		if (this.snapshot.restoring) void this.restore();
	}

	/**
	 * Replays a persisted token into the bun process on startup. The token isn't
	 * verified here — the library refresh that fires on `loggedIn` validates it,
	 * and a 401 there clears the token and drops back to the login screen.
	 */
	private async restore(): Promise<void> {
		const host = localStorage.getItem(HOST_KEY) ?? "";
		const port = Number(localStorage.getItem(PORT_KEY));
		const token = localStorage.getItem(TOKEN_KEY) ?? "";
		try {
			const result = await bun.restoreSession({ host, port, token });
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

	async login(
		host: string,
		port: number,
		username: string,
		password: string,
	): Promise<void> {
		if (this.snapshot.status === "loggingIn") return;
		this.update({ status: "loggingIn", error: null });
		let result;
		try {
			result = await bun.login({ host, port, username, password });
		} catch (err) {
			// RPC transport failure or timeout (e.g. bun process unreachable).
			this.update({
				status: "loggedOut",
				error: err instanceof Error ? err.message : "Login request failed",
			});
			return;
		}
		if (result.ok) {
			localStorage.setItem(HOST_KEY, host);
			localStorage.setItem(PORT_KEY, String(port));
			// Persist the token so the session survives a restart (see restore()).
			localStorage.setItem(TOKEN_KEY, result.token);
			this.update({
				status: "loggedIn",
				lastHost: host,
				lastPort: String(port),
			});
		} else {
			this.update({ status: "loggedOut", error: result.error });
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
		localStorage.removeItem(TOKEN_KEY);
	}

	private update(patch: Partial<SessionState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** Whether a full session (host + port + token) is persisted for restore. */
function hasStoredSession(): boolean {
	return (
		!!localStorage.getItem(HOST_KEY) &&
		!!localStorage.getItem(PORT_KEY) &&
		!!localStorage.getItem(TOKEN_KEY)
	);
}

/** App-wide singleton — session state must survive component unmounts. */
export const sessionService = new SessionService();

// The stream proxy is the one server path that bypasses RPC requests, so a
// token rejected mid-stream reaches the webview as a pushed message instead
// of a 401 result.
onBunMessage("sessionExpired", ({ reason }) => {
	sessionService.markExpired(reason);
});
