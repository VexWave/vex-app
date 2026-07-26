import { sessionService } from "./SessionService";

/**
 * Where the main content area is: one of the three top-level views, with the
 * playlists and artists views optionally opened on a single item. One value —
 * rather than a view name plus open-item side state — so the sidebar, the nav
 * items and the main area can never disagree about the current location.
 */
export type MainView =
	| { name: "library" }
	| { name: "playlists"; openId: number | null }
	| { name: "artists"; openId: number | null };

export type MainViewName = MainView["name"];

/**
 * The item a list view is opened on (a playlist, an artist), or null when it
 * is showing its list — the library, having no detail view, is always null.
 */
export function openIdOf(view: MainView): number | null {
	return view.name === "library" ? null : view.openId;
}

/**
 * Owns the current location. It lives beside the other services rather than in
 * React state so anything can navigate without threading callbacks through the
 * tree — a track row links to one of its artists, the sidebar opens a
 * playlist — and so logging out can reset it: ids belong to the session that
 * issued them, and the next login's server may not have them at all.
 */
export class NavigationService {
	private subscribers = new Set<() => void>();
	private snapshot: MainView = { name: "library" };

	constructor() {
		let previousStatus = sessionService.getSnapshot().status;
		sessionService.subscribe(() => {
			const status = sessionService.getSnapshot().status;
			if (status === previousStatus) return;
			previousStatus = status;
			if (status === "loggedOut") this.set({ name: "library" });
		});
	}

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): MainView => this.snapshot;

	/** Show a top-level view's list, closing any item opened in it. */
	show = (name: MainViewName): void => {
		this.set(name === "library" ? { name } : { name, openId: null });
	};

	/** Open a playlist's detail view (null returns to the playlist grid). */
	openPlaylist = (playlistId: number | null): void => {
		this.set({ name: "playlists", openId: playlistId });
	};

	/** Open an artist's detail view (null returns to the artist grid). */
	openArtist = (artistId: number | null): void => {
		this.set({ name: "artists", openId: artistId });
	};

	// Identical navigations are dropped: they would hand
	// useSyncExternalStore a new snapshot object and re-render the whole main
	// area for nothing (clicking the active nav item, say).
	private set(view: MainView): void {
		const current = this.snapshot;
		if (current.name === view.name && openIdOf(current) === openIdOf(view)) {
			return;
		}
		this.snapshot = view;
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — the current location must survive component unmounts. */
export const navigationService = new NavigationService();
