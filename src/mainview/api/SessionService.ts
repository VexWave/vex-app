import { bun } from "./rpc";

export type SessionStatus = "loggedOut" | "loggingIn" | "loggedIn";

/** Immutable snapshot of the server session, consumed by the React layer. */
export interface SessionState {
	status: SessionStatus;
	error: string | null;
	/** Last successfully used server address, prefilled into the login form. */
	lastHost: string;
	lastPort: string;
}

const HOST_KEY = "player.server.host";
const PORT_KEY = "player.server.port";

/**
 * Tracks whether the user is logged in to a server. The token itself lives
 * in the bun process (ApiClient) and never enters the webview; credentials
 * are never persisted — only host/port are remembered for convenience.
 */
export class SessionService {
	private subscribers = new Set<() => void>();
	private snapshot: SessionState = {
		status: "loggedOut",
		error: null,
		lastHost: localStorage.getItem(HOST_KEY) ?? "",
		lastPort: localStorage.getItem(PORT_KEY) ?? "",
	};

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
			this.update({
				status: "loggedIn",
				lastHost: host,
				lastPort: String(port),
			});
		} else {
			this.update({ status: "loggedOut", error: result.error });
		}
	}

	/** Drops back to the login screen, e.g. when an upload hits a 401. */
	markExpired(message: string): void {
		this.update({ status: "loggedOut", error: message });
	}

	private update(patch: Partial<SessionState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — session state must survive component unmounts. */
export const sessionService = new SessionService();
