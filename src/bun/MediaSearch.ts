import type {
	MediaSearchResult,
	SearchMediaParams,
	SearchMediaResult,
	SearchSource,
} from "../shared/rpcSchema";
import { describeError, type BinaryManager } from "./BinaryManager";
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
 * Titles of things a music library wants no track of. Grouped rather than listed
 * one word per entry because a group is also the unit the query lifts (below):
 * asking for a "reaction" shouldn't stop lifting the penalty on "review".
 *
 * "Mix" needs both guards it has: no word boundary sits inside "remix", and the
 * lookbehind spares the electronic-release wordings ("Original Mix", "Extended
 * Mix") where a mix is one version of one track rather than a run of many.
 */
const NON_SONG_PATTERNS = [
	/\b(?:dj[ -]?set|mega ?mix|mixtape|(?<!\b(?:original|extended|club|radio|vip|dub|instrumental|festival)\s)mix)\b/,
	/\b(?:full album|compilation|playlist|medley|nonstop)\b/,
	/\blive (?:at|in|from|on|session|performance)\b/,
	/\b\d+\s*hours?\b/,
	/\b(?:reaction|review|interview|tutorial|podcast|trailer|karaoke|documentary|type beat)\b/,
];

/** What the query left standing of NON_SONG_PATTERNS, and why it matters. */
interface Ranking {
	/** The patterns that may still count against a title. */
	penalties: readonly RegExp[];
	/** The query asked for one of them, so long running media is wanted too. */
	queryWantsLongForm: boolean;
}

/** Shorter than this is a clip or a preview snippet, not the track. */
const MIN_SONG_SEC = 45;
/** Songs run past 9 minutes; almost nothing past 15 is one. */
const LONG_SONG_SEC = 9 * 60;
const NOT_A_SONG_SEC = 15 * 60;

/**
 * Searches YouTube/SoundCloud through the managed yt-dlp for the Discover view.
 * `--flat-playlist` keeps it to the platform's own search endpoint — no entry is
 * resolved — so one process answers a whole page in a single round-trip, fast
 * enough to return from the RPC request instead of streaming progress the way
 * downloads have to. The page is then re-ranked towards actual songs
 * (`songAffinity`), since neither platform's search knows it is answering a
 * music player.
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
	// Patterns the query itself asks for stop counting against a title: someone
	// searching for a two-hour mix is looking for exactly what the ranking would
	// otherwise bury. What's left is what may still be penalised.
	const lowerQuery = query.toLowerCase();
	const penalties = NON_SONG_PATTERNS.filter(
		(pattern) => !pattern.test(lowerQuery),
	);
	const ranking: Ranking = {
		penalties,
		queryWantsLongForm: penalties.length < NON_SONG_PATTERNS.length,
	};
	const scored: { result: MediaSearchResult; score: number }[] = [];
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
		scored.push({
			result: {
				// Source-prefixed so the id is a React key that holds whatever the
				// platform numbers its media by, and falls back to the page URL for
				// one that reports no id at all.
				id: `${source}:${entry.id ?? url}`,
				title,
				url,
				// SoundCloud names only an uploader; YouTube sets both, and
				// `channel` is the display name of the two.
				artist: cleanArtistName(entry.channel ?? entry.uploader),
				durationSec,
				thumbnailUrl: pickThumbnailUrl(entry.thumbnails),
			},
			score: songAffinity(entry, title.toLowerCase(), durationSec, ranking),
		});
	}
	// Array#sort is stable, so hits the ranking can't tell apart keep the
	// platform's own relevance order — this reorders by songiness, it doesn't
	// replace the search's judgement of what the query meant.
	return scored
		.sort((a, b) => b.score - a.score)
		.map((entry) => entry.result);
}

/**
 * How much a hit looks like a song rather than something else that happens to
 * contain music. A search for a track otherwise competes with live sets, hour
 * long mixes, reactions and 30-second clips, all of which a music library only
 * ever wants further down.
 *
 * Nothing is dropped — the ranking can be wrong, and a demoted result is still
 * two rows away.
 */
function songAffinity(
	entry: SearchEntry,
	lowerTitle: string,
	durationSec: number | undefined,
	{ penalties, queryWantsLongForm }: Ranking,
): number {
	let score = 0;

	// YouTube's auto-generated per-artist channels ("Artist - Topic") carry
	// nothing but released tracks, which also makes them the cleanest source of
	// title and artist. Read off the raw channel: the artist name has already
	// had the suffix stripped for display.
	if (/\s-\s*Topic$/i.test(entry.channel ?? "")) score += 3;
	// An "official" anything from a music search is the release itself.
	if (/\bofficial\b/.test(lowerTitle)) score += 2;
	if (entry.channel_is_verified) score += 1;

	if (durationSec === undefined) {
		score -= 4; // a live stream: no length, and nothing to download
	} else if (durationSec < MIN_SONG_SEC) {
		score -= 4;
	} else if (durationSec <= LONG_SONG_SEC) {
		score += 2;
	} else if (durationSec > NOT_A_SONG_SEC && !queryWantsLongForm) {
		score -= 3;
	}

	for (const pattern of penalties) {
		if (pattern.test(lowerTitle)) score -= 3;
	}
	return score;
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
