import type { MediaSearchResult, SearchSource } from "../../shared/rpcSchema";
import { storage } from "@/lib/storage";
import { importService, parseImportUrl } from "./ImportService";
import { bun } from "./rpc";

export interface DiscoverState {
	source: SearchSource;
	/**
	 * The query the current results answer, set the moment a search starts; ""
	 * until the first one, which is what "nothing searched yet" means.
	 */
	query: string;
	results: readonly MediaSearchResult[];
	loading: boolean;
	/** Why the last search failed; results are empty whenever it is set. */
	error: string | null;
}

/**
 * Backs the Discover view: yt-dlp searches of YouTube/SoundCloud, and downloads
 * of what they turn up. A download is the ordinary URL import — the result's page
 * URL goes to ImportService, which stages the finished mp3 in the upload-review
 * dialog with title, cover and creator prefilled.
 *
 * Nothing here is session-scoped: searching talks to the platform through the
 * bun-side yt-dlp, never to the backend, so results and an in-flight search
 * survive a logout the same way running imports do.
 */
export class DiscoverService {
	private subscribers = new Set<() => void>();
	private snapshot: DiscoverState = {
		source: storage.discover.source.get() ?? "youtube",
		query: "",
		results: [],
		loading: false,
		error: null,
	};
	/** Bumped per search; only the newest response may write the snapshot. */
	private generation = 0;

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): DiscoverState => this.snapshot;

	/**
	 * Switch platforms. The query carries over: the same words on the other
	 * platform is what "switch source" means, and leaving the old platform's hits
	 * on screen under the new label would be a lie.
	 */
	setSource = (source: SearchSource): void => {
		if (source === this.snapshot.source) return;
		storage.discover.source.set(source);
		this.update({ source });
		this.retry();
	};

	search = async (query: string): Promise<void> => {
		const term = query.trim();
		if (!term) return;
		const generation = ++this.generation;
		// Results are dropped up-front: they answer the previous query, and the
		// view shows its loading state in their place.
		this.update({ query: term, results: [], loading: true, error: null });
		try {
			const result = await bun.searchMedia({
				query: term,
				source: this.snapshot.source,
			});
			// A newer search (or a source switch) took over while this one ran —
			// its own response owns the snapshot from here.
			if (generation !== this.generation) return;
			this.update(
				result.ok
					? { results: result.results, loading: false }
					: { loading: false, error: result.error },
			);
		} catch (err) {
			if (generation !== this.generation) return;
			this.update({
				loading: false,
				error: err instanceof Error ? err.message : "Search failed",
			});
		}
	};

	/** Run the current query again — the retry button, and a platform switch. */
	retry = (): void => {
		if (this.snapshot.query) void this.search(this.snapshot.query);
	};

	/**
	 * Download a result, which lands in the upload-review dialog. Bound to the
	 * singleton and taking the result itself, so a card can hand it straight over
	 * as a stable callback. Nothing to report back: a hit whose URL no importer
	 * accepts is never offered for download in the first place.
	 */
	download = (result: MediaSearchResult): void => {
		const url = parseImportUrl(result.url);
		if (url) void importService.start(url);
	};

	private update(patch: Partial<DiscoverState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — results outlive the view they're rendered in. */
export const discoverService = new DiscoverService();
