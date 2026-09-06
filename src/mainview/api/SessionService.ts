import { storage } from "@/lib/storage";
import { bun, onBunMessage } from "./rpc";

export type SessionStatus = "loggedOut" | "loggingIn" | "loggedIn";

export function parseServerUrl(raw: string): string | null {
	const input = raw.trim();
	if (!/^https?:\/\//i.test(input)) return null;
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return null;
	}
	if (url.port === "0") return null;
	return url.origin + url.pathname.replace(/\/+$/, "");
}

export interface SessionState {
	status: SessionStatus;
	error: string | null;
	lastServerUrl: string;
	restoring: boolean;
	retryAfter: number | null;
}

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
			restoring: !!baseUrl && !!token,
			retryAfter: null,
		};
		if (this.snapshot.restoring) void this.restore(baseUrl, token);
	}

	private async restore(baseUrl: string, token: string): Promise<void> {
		try {
			const result = await bun.restoreSession({ baseUrl, token });
			if (result.ok) {
				this.update({ status: "loggedIn", restoring: false });
				return;
			}
		} catch {
		}
		this.clearStoredToken();
		this.update({ status: "loggedOut", restoring: false });
	}

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): SessionState => this.snapshot;

	async login(
		baseUrl: string,
		username: string,
		password: string,
	): Promise<void> {
		if (this.snapshot.status === "loggingIn") return;
		if (this.snapshot.retryAfter !== null && Date.now() < this.snapshot.retryAfter) {
			return;
		}
		this.update({ status: "loggingIn", error: null, retryAfter: null });
		let result;
		try {
			result = await bun.login({ baseUrl, username, password });
		} catch (err) {
			this.update({
				status: "loggedOut",
				error: err instanceof Error ? err.message : "Login request failed",
			});
			return;
		}
		if (result.ok) {
			storage.session.url.set(baseUrl);
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

	async logout(): Promise<void> {
		this.clearStoredToken();
		try {
			await bun.logout();
		} catch {
		}
		this.update({ status: "loggedOut", error: null });
	}

	markExpired(message: string): void {
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

export const sessionService = new SessionService();

onBunMessage("sessionExpired", ({ reason }) => {
	sessionService.markExpired(reason);
});
