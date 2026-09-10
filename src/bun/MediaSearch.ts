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

const SEARCH_PREFIX: Record<SearchSource, string> = {
	youtube: "ytsearch",
	soundcloud: "scsearch",
};

const RESULT_LIMIT = 24;

const RESULT_MARK = "VEX>S ";

const RESULT_TEMPLATE =
	"%(.{id,title,duration,channel,channel_is_verified,uploader,webpage_url,url,thumbnails})j";

const SEARCH_TIMEOUT_MS = 45_000;

const MAX_QUERY_LENGTH = 200;

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

export class MediaSearch {
	private running: ReturnType<typeof Bun.spawn> | null = null;
	private generation = 0;

	constructor(
		private readonly binaries: BinaryManager,
		private readonly proxy: () => string | undefined,
	) {}

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
			{
				env: childEnv(this.binaries.binDir, this.proxy()),
				stdout: "pipe",
				stderr: "pipe",
			},
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

		if (generation !== this.generation) {
			return { ok: false, error: "Superseded by a newer search." };
		}
		if (timedOut) {
			return { ok: false, error: "The search timed out." };
		}
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
			continue;
		}
		const url = entry.webpage_url ?? entry.url;
		const title = entry.title?.trim();
		if (!url || !title) continue;
		const durationSec = ytDlpNumber(entry.duration);
		const artist = cleanArtistName(entry.channel ?? entry.uploader);
		hits.push({
			result: {
				id: `${source}:${entry.id ?? url}`,
				title,
				url,
				artist,
				durationSec,
				thumbnailUrl: pickThumbnailUrl(entry.thumbnails),
			},
			signals: {
				title,
				creator: artist ?? "",
				durationSec,
				topicChannel: /\s-\s*Topic$/i.test(entry.channel ?? ""),
				verified: entry.channel_is_verified === true,
			},
		});
	}
	return rankHits(hits, query).map((hit) => hit.result);
}

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
