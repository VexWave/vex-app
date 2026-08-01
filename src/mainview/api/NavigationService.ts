import { sessionService } from "./SessionService";

/**
 * The views that can be opened on one of their items, as opposed to only ever
 * showing a list. Declared once: `set` dedupes on the name *plus* the open id, so
 * a detail view missing from here would report no open id and have every
 * navigation between two of its items silently dropped as a repeat.
 */
const DETAIL_VIEWS = ["playlists", "artists"] as const;

type DetailViewName = (typeof DETAIL_VIEWS)[number];

/**
 * Where the main content area is: one of the top-level views, with the playlists
 * and artists views optionally opened on a single item. One value — rather than a
 * view name plus open-item side state — so the sidebar, the nav items and the
 * main area can never disagree about the current location.
 */
export type MainView =
	| { name: "library" }
	| { name: "discover" }
	| { name: DetailViewName; openId: number | null };

export type MainViewName = MainView["name"];

function hasDetail(name: MainViewName): name is DetailViewName {
	return (DETAIL_VIEWS as readonly MainViewName[]).includes(name);
}

/**
 * The item a list view is opened on (a playlist, an artist), or null when it is
 * showing its list — the library and Discover, having no detail view, are always
 * null. Reads the shape rather than the name, so it needs no edit when a view is
 * added either way.
 */
export function openIdOf(view: MainView): number | null {
	return "openId" in view ? view.openId : null;
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
		this.set(hasDetail(name) ? { name, openId: null } : { name });
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
