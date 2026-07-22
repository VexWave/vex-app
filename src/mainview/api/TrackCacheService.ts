import { bun, onBunMessage } from "./rpc";
import { sessionService } from "./SessionService";

/**
 * Mirrors the bun-side track memory cache (StreamProxy/TrackCache): the set of
 * server track ids whose full audio is cached, so the UI can mark those rows
 * as instant to play. Membership changes arrive as pushed `trackCacheChanged`
 * messages; on login the current set is fetched once, which also covers dev
 * HMR reloads (the webview restarts, bun and its cache don't).
 */
export class TrackCacheService {
	private subscribers = new Set<() => void>();
	private snapshot: ReadonlySet<number> = new Set();

	constructor() {
		onBunMessage("trackCacheChanged", ({ trackIds }) => {
			this.replace(trackIds);
		});
		let previousStatus = sessionService.getSnapshot().status;
		sessionService.subscribe(() => {
			const status = sessionService.getSnapshot().status;
			if (status === previousStatus) return;
			previousStatus = status;
			if (status === "loggedIn") {
				// Best-effort hydration; a failure just means no badges until the
				// next trackCacheChanged push.
				void bun
					.getCachedTracks()
					.then(({ trackIds }) => this.replace(trackIds))
					.catch(() => {});
			} else if (status === "loggedOut") {
				this.replace([]);
			}
		});
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): ReadonlySet<number> => this.snapshot;

	private replace(trackIds: number[]): void {
		this.snapshot = new Set(trackIds);
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — cache state must survive component unmounts. */
export const trackCacheService = new TrackCacheService();
