export interface HitSignals {
	title: string;
	creator: string;
	durationSec: number | undefined;
	topicChannel: boolean;
	verified: boolean;
}

const RELEVANCE_WEIGHT = 16;
const CREATOR_WEIGHT = 3;
const PLATFORM_WEIGHT = 5;
const PLATFORM_HALF_LIFE = 8;

const MIN_SONG_SEC = 45;
const LONG_SONG_SEC = 9 * 60;
const NOT_A_SONG_SEC = 15 * 60;

const NOT_A_TRACK = [
	/\b(?:dj[ -]?set|mega ?mix|mixtape|(?<!\b(?:original|extended|club|radio|vip|dub|instrumental|festival)\s)mix)\b/,
	/\b(?:full album|compilation|playlist|medley|nonstop)\b/,
	/\b\d+\s*hours?\b/,
	/\b(?:reaction|review|interview|tutorial|podcast|trailer|karaoke|documentary|type beat)\b/,
];

const NOT_THE_TRACK = [
	/\blive\b/,
	/\b(?:behind the scenes|making of|teaser|snippet|preview)\b/,
	/\b(?:instrumental|acapella|a cappella)\b/,
	/\b(?:sped up|slowed|nightcore|8d audio|bass boosted)\b/,
	/\b(?:cover|remake|tribute|parody|remix|flip|mashup|bootleg)\b/,
];

const NOT_A_TRACK_PENALTY = 5;
const NOT_THE_TRACK_PENALTY = 3;

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.replace(/[\u2018\u2019\u02bc\u00b4'`]/g, "")
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

function editBudget(length: number): number {
	if (length <= 3) return 0;
	if (length <= 6) return 1;
	return 2;
}

function withinEditDistance(a: string, b: string, max: number): boolean {
	if (Math.abs(a.length - b.length) > max) return false;
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
			row.push(value);
			if (value < best) best = value;
		}
		if (best > max) return false;
		previous = row;
	}
	return previous[b.length] <= max;
}

function tokenMatch(queryToken: string, token: string): number {
	if (queryToken === token) return 1;
	if (queryToken.length >= 4 && token.startsWith(queryToken)) return 0.9;
	if (token.length >= 4 && queryToken.startsWith(token)) return 0.85;
	const budget = editBudget(queryToken.length);
	if (budget > 0 && withinEditDistance(queryToken, token, budget)) return 0.8;
	return 0;
}

function bestMatch(queryToken: string, tokens: readonly string[]): number {
	let best = 0;
	for (const token of tokens) {
		const score = tokenMatch(queryToken, token);
		if (score > best) best = score;
		if (best === 1) break;
	}
	return best;
}

function liftPatterns(patterns: readonly RegExp[], lowerQuery: string): RegExp[] {
	return patterns.filter((pattern) => !pattern.test(lowerQuery));
}

interface Candidate<T> {
	hit: T;
	signals: HitSignals;
	index: number;
	tokens: string[];
	creatorTokens: string[];
	lowerTitle: string;
	matches: number[];
}

export function rankHits<T extends { signals: HitSignals }>(
	hits: readonly T[],
	query: string,
): T[] {
	if (hits.length < 2) return [...hits];

	const queryTokens = [...new Set(tokenize(query))];
	const lowerQuery = query.toLowerCase();
	const notATrack = liftPatterns(NOT_A_TRACK, lowerQuery);
	const notTheTrack = liftPatterns(NOT_THE_TRACK, lowerQuery);
	const queryWantsLongForm = notATrack.length < NOT_A_TRACK.length;

	const candidates: Candidate<T>[] = hits.map((hit, index) => {
		const tokens = tokenize(hit.signals.title);
		const creatorTokens = tokenize(hit.signals.creator);
		return {
			hit,
			signals: hit.signals,
			index,
			tokens,
			creatorTokens,
			lowerTitle: hit.signals.title.toLowerCase(),
			matches: queryTokens.map((queryToken) =>
				Math.max(bestMatch(queryToken, tokens), bestMatch(queryToken, creatorTokens)),
			),
		};
	});

	const weights = queryTokens.map((_, position) => {
		const documentFrequency = candidates.reduce(
			(count, candidate) => count + (candidate.matches[position] > 0 ? 1 : 0),
			0,
		);
		return Math.log(1 + hits.length / (1 + documentFrequency));
	});
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;

	return candidates
		.map((candidate) => ({
			hit: candidate.hit,
			score: scoreCandidate(candidate, weights, totalWeight, queryTokens, {
				notATrack,
				notTheTrack,
				queryWantsLongForm,
			}),
		}))
		.sort((a, b) => b.score - a.score)
		.map((scored) => scored.hit);
}

interface Lifted {
	notATrack: readonly RegExp[];
	notTheTrack: readonly RegExp[];
	queryWantsLongForm: boolean;
}

function scoreCandidate<T>(
	candidate: Candidate<T>,
	weights: readonly number[],
	totalWeight: number,
	queryTokens: readonly string[],
	lifted: Lifted,
): number {
	const answered = candidate.matches.reduce(
		(sum, match, position) => sum + match * weights[position],
		0,
	);
	const relevance = answered / totalWeight;

	const named = candidate.creatorTokens.reduce(
		(sum, token) => sum + bestMatch(token, queryTokens),
		0,
	);
	const creator = candidate.creatorTokens.length
		? named / candidate.creatorTokens.length
		: 0;

	const prior =
		PLATFORM_WEIGHT * (PLATFORM_HALF_LIFE / (PLATFORM_HALF_LIFE + candidate.index));

	return (
		RELEVANCE_WEIGHT * relevance +
		CREATOR_WEIGHT * creator +
		songAffinity(candidate, lifted) +
		prior
	);
}

function songAffinity<T>(
	candidate: Candidate<T>,
	{ notATrack, notTheTrack, queryWantsLongForm }: Lifted,
): number {
	const { signals } = candidate;
	let score = 0;

	if (signals.topicChannel) score += 3;
	if (/\bofficial\b/.test(candidate.lowerTitle)) score += 2;
	if (signals.verified) score += 1;

	const { durationSec } = signals;
	if (durationSec === undefined) {
		score -= 4;
	} else if (durationSec < MIN_SONG_SEC) {
		score -= 3;
	} else if (durationSec <= LONG_SONG_SEC) {
		score += 2;
	} else if (durationSec > NOT_A_SONG_SEC && !queryWantsLongForm) {
		score -= 3;
	}

	for (const pattern of notATrack) {
		if (pattern.test(candidate.lowerTitle)) score -= NOT_A_TRACK_PENALTY;
	}
	for (const pattern of notTheTrack) {
		if (pattern.test(candidate.lowerTitle)) score -= NOT_THE_TRACK_PENALTY;
	}
	return score;
}
