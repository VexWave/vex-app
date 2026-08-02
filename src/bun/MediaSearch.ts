import type {
	MediaSearchResult,
	SearchMediaParams,
	SearchMediaResult,
	SearchSource,
} from "../shared/rpcSchema";
import { describeError, type BinaryManager } from "./BinaryManager";
import { rankHits, type HitSignals } from "./searchRanking";
import {
	childEnv,
	cleanArtistName,
	collectStderr,
	describeYtDlpFailure,
	readYtDlpOutput,
	YT_DLP_BASE_ARGS,
	ytDlpNumber,
} from "./ytDlp";

/** yt-dlp's search prefix per platform; the count goes between it and the query. */
const SEARCH_PREFIX: Record<SearchSource, string> = {
	youtube: "ytsearch",
	soundcloud: "scsearch",
};

/** Hits per search — enough to fill the result grid without paging. */
const RESULT_LIMIT = 24;

/**
 * Marker prefixed to every printed result, so only lines this template produced
 * are parsed as one — same reasoning as UrlImporter's progress markers.
 */
const RESULT_MARK = "VEX>S ";

/**
 * The entry fields a result card needs, as one JSON object per hit (`j`
 * serializes the selection, so a title containing any separator can't split a
 * line). Fields the platform doesn't set are simply absent from the object.
 */
const RESULT_TEMPLATE =
	"%(.{id,title,duration,channel,channel_is_verified,uploader,webpage_url,url,thumbnails})j";

/** A search is a single metadata call; slower than this is a hang, not a wait. */
const SEARCH_TIMEOUT_MS = 45_000;

/** Beyond this neither platform's search does anything useful with the input. */
const MAX_QUERY_LENGTH = 200;

/** yt-dlp's flat search entry, restricted to RESULT_TEMPLATE's fields. */
interface SearchEntry {
	id?: string;
	title?: string;
	duration?: number;
	channel?: string;
	channel_is_verified?: boolean;
	uploader?: string;
	webpage_url?: string;
	url?: string;
	thumbnails?: { url?: string; width?: number }[];
}

/**
 * Searches YouTube/SoundCloud through the managed yt-dlp for the Discover view.
 * `--flat-playlist` keeps it to the platform's own search endpoint — no entry is
 * resolved — so one process answers a whole page in a single round-trip, fast
 * enough to return from the RPC request instead of streaming progress the way
 * downloads have to. The page is then re-ranked against the query and towards
 * actual songs (`./searchRanking`), since neither platform's search knows it is
 * answering a music player.
 *
 * One search runs at a time: a new query kills the one still running, whose
 * results the webview has already stopped waiting for. That also bounds how many
 * yt-dlp processes a user hammering the search button can start.
 */
export class MediaSearch {
	private running: ReturnType<typeof Bun.spawn> | null = null;
	/** Bumped per search, so a superseded run can recognise itself as stale. */
	private generation = 0;

	constructor(private readonly binaries: BinaryManager) {}

	/** True while a search process is alive (blocks the yt-dlp updater). */
	get isActive(): boolean {
		return this.running !== null;
	}

	async run({ query, source }: SearchMediaParams): Promise<SearchMediaResult> {
		if (!this.binaries.isSupported) {
			return { ok: false, error: "Searching is not supported on this platform." };
		}
		const term = query.trim().replace(/\s+/g, " ").slice(0, MAX_QUERY_LENGTH);
		if (!term) return { ok: true, results: [] };

		this.running?.kill();
		this.running = null;
		const generation = ++this.generation;
		try {
			return await this.spawnSearch(term, source, generation);
		} catch (err) {
			return { ok: false, error: describeError(err) };
		}
	}

	private async spawnSearch(
		term: string,
		source: SearchSource,
		generation: number,
	): Promise<SearchMediaResult> {
		const proc = Bun.spawn(
			[
				this.binaries.ytDlpPath(),
				...YT_DLP_BASE_ARGS,
				"--flat-playlist",
				"--print", `${RESULT_MARK}${RESULT_TEMPLATE}`,
				`${SEARCH_PREFIX[source]}${RESULT_LIMIT}:${term}`,
			],
			{ env: childEnv(this.binaries.binDir), stdout: "pipe", stderr: "pipe" },
		);
		this.running = proc;

		const stderrTail = collectStderr(proc.stderr);
		let timedOut: boolean;
		let stdout: string;
		try {
			({ stdout, timedOut } = await readYtDlpOutput(proc, SEARCH_TIMEOUT_MS));
		} finally {
			if (this.running === proc) this.running = null;
		}

		// A newer query took over while this ran (and killed it) — whatever it
		// printed answers a search the webview has moved on from. Checked before
		// the results are read, so a half-printed page can't be mistaken for an
		// answer to the current query.
		if (generation !== this.generation) {
			return { ok: false, error: "Superseded by a newer search." };
		}
		if (timedOut) {
			return { ok: false, error: "The search timed out." };
		}
		// A non-zero exit does not mean nothing came back: yt-dlp reports one
		// unavailable entry or a failed continuation page by exit code while the
		// hits it did resolve are already on stdout. A page of results is a better
		// answer than an error about the ones that are missing.
		const results = parseResults(stdout, source, term);
		if (results.length === 0 && proc.exitCode !== 0) {
			return {
				ok: false,
				error: await describeYtDlpFailure(proc.exitCode, stderrTail),
			};
		}
		return { ok: true, results };
	}
}

function parseResults(
	stdout: string,
	source: SearchSource,
	query: string,
): MediaSearchResult[] {
	const hits: { result: MediaSearchResult; signals: HitSignals }[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.startsWith(RESULT_MARK)) continue;
		let entry: SearchEntry;
		try {
			entry = JSON.parse(line.slice(RESULT_MARK.length));
		} catch {
			continue; // one unreadable hit doesn't cost the rest of the page
		}
		// webpage_url, not url: SoundCloud's flat entries put an
		// api.soundcloud.com resource in `url`, which is not a page an import
		// takes. It's only the fallback for a platform that omits the former.
		const url = entry.webpage_url ?? entry.url;
		const title = entry.title?.trim();
		if (!url || !title) continue;
		const durationSec = ytDlpNumber(entry.duration);
		// SoundCloud names only an uploader; YouTube sets both, and `channel` is
		// the display name of the two.
		const artist = cleanArtistName(entry.channel ?? entry.uploader);
		hits.push({
			result: {
				// Source-prefixed so the id is a React key that holds whatever the
				// platform numbers its media by, and falls back to the page URL for
				// one that reports no id at all.
				id: `${source}:${entry.id ?? url}`,
				title,
				url,
				artist,
				durationSec,
				thumbnailUrl: pickThumbnailUrl(entry.thumbnails),
			},
			signals: {
				title,
				// The cleaned name, so a Topic channel's creator matches a query
				// naming the artist as plainly as any other channel's does; the
				// suffix itself travels as `topicChannel`.
				creator: artist ?? "",
				durationSec,
				topicChannel: /\s-\s*Topic$/i.test(entry.channel ?? ""),
				verified: entry.channel_is_verified === true,
			},
		});
	}
	// The hits arrive in the platform's own relevance order, which the ranking
	// reads as a signal in its own right rather than as a starting point.
	return rankHits(hits, query).map((hit) => hit.result);
}

/**
 * The largest thumbnail of known size — YouTube's search entries top out at
 * 720px wide, SoundCloud's at 500. SoundCloud also lists an "original" with no
 * dimensions, which can be arbitrarily large, so an unsized candidate is only
 * taken when nothing carries a size at all.
 */
function pickThumbnailUrl(
	thumbnails: { url?: string; width?: number }[] | undefined,
): string | undefined {
	if (!Array.isArray(thumbnails)) return undefined;
	let widest: { url: string; width: number } | undefined;
	let unsized: string | undefined;
	for (const thumb of thumbnails) {
		if (typeof thumb?.url !== "string") continue;
		if (typeof thumb.width === "number") {
			if (!widest || thumb.width > widest.width) {
				widest = { url: thumb.url, width: thumb.width };
			}
		} else {
			unsized ??= thumb.url;
		}
	}
	return widest?.url ?? unsized;
}
