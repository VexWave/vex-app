import type { RemoteLibrary } from "../../shared/rpcSchema";
import { bun } from "./rpc";
import { sessionService } from "./SessionService";

export interface LibraryDataState extends RemoteLibrary {
	loading: boolean;
	error: string | null;
}

/**
 * The only thing in the app that reads the library: one `getLibrary` answers
 * with tracks, artists and playlists from one server snapshot, so the three
 * cannot disagree — true only while nothing else fetches a slice of its own.
 *
 * Emptied on logout: stream URLs are valid only against the session that
 * produced them.
 */
export class LibraryData {
	private subscribers = new Set<() => void>();
	private snapshot: LibraryDataState = {
		tracks: [],
		artists: [],
		playlists: [],
		loading: false,
		error: null,
	};
	private fetchSeq = 0;

	constructor() {
		let previousStatus = sessionService.getSnapshot().status;
		sessionService.subscribe(() => {
			const status = sessionService.getSnapshot().status;
			if (status === previousStatus) return;
			previousStatus = status;
			if (status === "loggedIn") {
				void this.refresh();
			} else if (status === "loggedOut") {
				this.fetchSeq += 1; // drop in-flight results from the old session
				this.update({
					tracks: [],
					artists: [],
					playlists: [],
					loading: false,
					error: null,
				});
			}
		});
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): LibraryDataState => this.snapshot;

	/**
	 * `true` once a fresh payload is applied, or once a newer refresh has
	 * superseded this one; `false` only if the read failed. An upload waits on
	 * it before dropping its pending placeholder.
	 */
	async refresh(): Promise<boolean> {
		const seq = ++this.fetchSeq;
		this.update({ loading: true, error: null });
		let result;
		try {
			result = await bun.getLibrary();
		} catch (err) {
			if (seq !== this.fetchSeq) return true; // a newer refresh will apply
			this.update({
				loading: false,
				error:
					err instanceof Error ? err.message : "Failed to load the library",
			});
			return false;
		}
		if (seq !== this.fetchSeq) return true; // a newer refresh will apply
		if (!result.ok) {
			if (result.status === 401) {
				sessionService.markExpired("Session expired — please log in again.");
			}
			this.update({ loading: false, error: result.error });
			return false;
		}
		this.update({
			tracks: result.tracks,
			artists: result.artists,
			playlists: result.playlists,
			loading: false,
			error: null,
		});
		return true;
	}

	// A patch that only moves `loading` leaves the three arrays identical, so
	// subscribers can rebuild off array identity rather than off every notify.
	private update(patch: Partial<LibraryDataState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — the library must survive component unmounts. */
export const libraryData = new LibraryData();
