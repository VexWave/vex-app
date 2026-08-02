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
	| { name: "settings" }
	| { name: DetailViewName; openId: number | null };

export type MainViewName = MainView["name"];

/**
 * Which section each view belongs to. A section is one of the app's sides — the
 * switch in the app bar moves between them, and the views inside one are what you
 * navigate between while its segment stays lit.
 *
 * Every section is named after the view it opens on, so its own row points at
 * itself and there is no second table saying where entering it lands. The name it
 * *shows* is free to be something else: labels, glyphs and chrome live in
 * `components/Sections`.
 *
 * Exhaustive over `MainViewName`, so a view added to the union without a section
 * here is a compile error rather than a view that shows with no segment lit.
 */
const SECTION_OF = {
	library: "library",
	playlists: "library",
	artists: "library",
	discover: "discover",
	settings: "settings",
} as const satisfies Record<MainViewName, MainViewName>;

/**
 * The app's sides: the views whose row points at themselves. Written as a filter
 * rather than as the table's plain value union so the "named after the view it
 * opens on" rule above is *checked* — a row pointing at a view that is itself
 * inside another section drops out of this union, and `sectionOf` below then
 * fails to return what it promises. Left unchecked, that row would have the
 * resumed-view map written under one key and read under another.
 */
export type SectionName = {
	[V in MainViewName]: (typeof SECTION_OF)[V] extends V ? V : never;
}[MainViewName];

/** Where the app opens, and where logging out puts it back. */
const HOME_SECTION: SectionName = "library";

function hasDetail(name: MainViewName): name is DetailViewName {
	return (DETAIL_VIEWS as readonly MainViewName[]).includes(name);
}

/** The section a view lives in — which segment of the switch is lit while it shows. */
export function sectionOf(view: MainView): SectionName {
	return SECTION_OF[view.name];
}

/** A top-level view showing its list, with no item opened in it. */
function viewOf(name: MainViewName): MainView {
	return hasDetail(name) ? { name, openId: null } : { name };
}

/**
 * The item a list view is opened on (a playlist, an artist), or null when it is
 * showing its list — a view with no detail view of its own is always null. Reads
 * the shape rather than the name, so it needs no edit when a view is added
 * either way.
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
	/**
	 * The view each section was last showing. A section is switched to rather than
	 * navigated to — its segment is on screen the whole time you are elsewhere — so
	 * coming back resumes it, open playlist and all, instead of dropping you at its
	 * home. An entry per section rather than one shared history: with every section
	 * one press away, "the way back" is a place each of them keeps.
	 *
	 * Only sections actually visited are in here; a missing one falls back to its
	 * home in `showSection`, which is why nothing has to enumerate the sections to
	 * seed this.
	 */
	private resume = new Map<SectionName, MainView>();
	private snapshot: MainView = viewOf(HOME_SECTION);

	constructor() {
		let previousStatus = sessionService.getSnapshot().status;
		sessionService.subscribe(() => {
			const status = sessionService.getSnapshot().status;
			if (status === previousStatus) return;
			previousStatus = status;
			if (status === "loggedOut") this.reset();
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
		this.set(viewOf(name));
	};

	/** Open a playlist's detail view (null returns to the playlist grid). */
	openPlaylist = (playlistId: number | null): void => {
		this.set({ name: "playlists", openId: playlistId });
	};

	/** Open an artist's detail view (null returns to the artist grid). */
	openArtist = (artistId: number | null): void => {
		this.set({ name: "artists", openId: artistId });
	};

	/**
	 * Switch to a section, resuming the view it was last showing — or, the first
	 * time, opening the view it is named after.
	 */
	showSection = (name: SectionName): void => {
		this.set(this.resume.get(name) ?? viewOf(name));
	};

	// Identical navigations are dropped: they would hand
	// useSyncExternalStore a new snapshot object and re-render the whole main
	// area for nothing (clicking the active nav item, say).
	private set(view: MainView): void {
		const current = this.snapshot;
		if (current.name === view.name && openIdOf(current) === openIdOf(view)) {
			return;
		}
		this.resume.set(sectionOf(view), view);
		this.snapshot = view;
		this.subscribers.forEach((notify) => notify());
	}

	/**
	 * Back to the home section, with every section's resumed view forgotten — a
	 * resumed view can hold ids the next session's server doesn't have.
	 */
	private reset(): void {
		this.resume.clear();
		this.set(viewOf(HOME_SECTION));
	}
}

/** App-wide singleton — the current location must survive component unmounts. */
export const navigationService = new NavigationService();
