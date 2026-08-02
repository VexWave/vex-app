/**
 * Re-ranks a page of platform search hits for the Discover view.
 *
 * Neither YouTube's nor SoundCloud's search knows it is answering a music
 * player, so a page mixes the track with hour-long mixes, live sets, reactions
 * and type beats. Ranking those down is only half the job: a hit that looks
 * every bit like a released single is still the wrong answer when it is a
 * *different* single by the artist whose name the query happened to contain.
 * So the score is led by how much of the query a hit actually answers, and the
 * songiness signals only order hits that answer it equally well.
 *
 * Nothing is dropped — the ranking can be wrong, and a demoted hit is still
 * two rows away.
 */

/** What the ranking reads off one hit. */
export interface HitSignals {
	title: string;
	/** Creator as displayed — YouTube's " - Topic" suffix already stripped. */
	creator: string;
	/** Whole seconds; absent for live streams and unknown lengths. */
	durationSec: number | undefined;
	/**
	 * The upload sits on an auto-generated per-artist "Topic" channel, which
	 * carries nothing but released tracks.
	 */
	topicChannel: boolean;
	verified: boolean;
}

/**
 * The weights the components are mixed at. Relevance is far the largest
 * because it answers a different question from the rest: the others say how
 * good a music result a hit is, and only relevance says whether it is the one
 * that was asked for. Its lead has to be wide enough that no pile of quality
 * bonuses lifts an unrelated track over a matching one — a search naming an
 * artist returns a whole page of their singles, every one of them an official
 * upload from a verified channel at song length.
 */
const RELEVANCE_WEIGHT = 16;
const CREATOR_WEIGHT = 3;
const PLATFORM_WEIGHT = 5;
/** Hits into the page at which the platform's prior has fallen by half. */
const PLATFORM_HALF_LIFE = 8;

/** Shorter than this is a clip or a preview snippet, not the track. */
const MIN_SONG_SEC = 45;
/** Songs run past 9 minutes; almost nothing past 15 is one. */
const LONG_SONG_SEC = 9 * 60;
const NOT_A_SONG_SEC = 15 * 60;

/**
 * Titles of things a music library wants no track of, in two tiers: media that
 * is not a track at all, and the right song in a recording nobody searching for
 * it means. They are separated because they deserve different penalties — an
 * hour of someone reacting to an album is never the answer, while a remix of
 * the searched track is merely the second-best one.
 *
 * Both are grouped rather than listed one word per entry because a group is
 * also the unit the query lifts (see `liftPatterns`): asking for a "reaction"
 * shouldn't stop lifting the penalty on "review".
 *
 * "Mix" needs both guards it has: no word boundary sits inside "remix", and the
 * lookbehind spares the electronic-release wordings ("Original Mix", "Extended
 * Mix") where a mix is one version of one track rather than a run of many.
 */
const NOT_A_TRACK = [
	/\b(?:dj[ -]?set|mega ?mix|mixtape|(?<!\b(?:original|extended|club|radio|vip|dub|instrumental|festival)\s)mix)\b/,
	/\b(?:full album|compilation|playlist|medley|nonstop)\b/,
	/\b\d+\s*hours?\b/,
	/\b(?:reaction|review|interview|tutorial|podcast|trailer|karaoke|documentary|type beat)\b/,
];

/**
 * The right song, the wrong recording of it. `live` is matched as a bare word
 * rather than by the wordings that follow it ("live at", "live from"), because
 * the ones that don't are just as much a concert recording — "Live Aid 1985",
 * "(Live)", "Live Video". A song whose own title contains the word is covered
 * by the query lifting the pattern, since the query has to contain it too.
 */
const NOT_THE_TRACK = [
	/\blive\b/,
	/\b(?:behind the scenes|making of|teaser|snippet|preview)\b/,
	/\b(?:instrumental|acapella|a cappella)\b/,
	/\b(?:sped up|slowed|nightcore|8d audio|bass boosted)\b/,
	/\b(?:cover|remake|tribute|parody|remix|flip|mashup|bootleg)\b/,
];

const NOT_A_TRACK_PENALTY = 5;
const NOT_THE_TRACK_PENALTY = 3;

// --- text ------------------------------------------------------------------

/**
 * Words of a title or a name, in the form the matching compares.
 *
 * Diacritics are folded so a query typed on a keyboard without them still finds
 * "SABÍA", and apostrophes are dropped rather than split on, so "what's" is one
 * token that a query typed as "whats" matches exactly. Splitting on everything
 * that is neither letter nor number keeps scripts other than Latin whole
 * instead of erasing them, which a plain `[a-z0-9]` class would do.
 */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.replace(/[\u2018\u2019\u02bc\u00b4'`]/g, "")
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

/**
 * Edits a token of this length may be off by and still be the same word. The
 * bands are the ones full-text engines settle on: too generous for short words
 * and every four-letter token matches every other.
 */
function editBudget(length: number): number {
	if (length <= 3) return 0;
	if (length <= 6) return 1;
	return 2;
}

/**
 * Whether two tokens are within `max` edits, abandoned as soon as the row's
 * best cell passes it — the answer is only ever wanted as a yes or no, and most
 * pairs on a page are nothing alike.
 */
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

/**
 * How well one query token is answered by one token of a hit, in [0, 1]. Titles
 * are what a user half-remembers and a platform stylizes, so a misspelling has
 * to still find them. Graded rather than boolean: a title spelling the word the
 * way the query did ranks above one that had to be guessed at.
 */
function tokenMatch(queryToken: string, token: string): number {
	if (queryToken === token) return 1;
	if (queryToken.length >= 4 && token.startsWith(queryToken)) return 0.9;
	if (token.length >= 4 && queryToken.startsWith(token)) return 0.85;
	const budget = editBudget(queryToken.length);
	if (budget > 0 && withinEditDistance(queryToken, token, budget)) return 0.8;
	return 0;
}

/** The best any of `tokens` answers `queryToken`. */
function bestMatch(queryToken: string, tokens: readonly string[]): number {
	let best = 0;
	for (const token of tokens) {
		const score = tokenMatch(queryToken, token);
		if (score > best) best = score;
		if (best === 1) break;
	}
	return best;
}

// --- ranking ---------------------------------------------------------------

/**
 * Patterns the query itself asks for stop counting against a title: someone
 * searching for a two-hour mix, a live album or a remix is looking for exactly
 * what the ranking would otherwise bury.
 */
function liftPatterns(patterns: readonly RegExp[], lowerQuery: string): RegExp[] {
	return patterns.filter((pattern) => !pattern.test(lowerQuery));
}

/** One hit with everything the score is computed from already measured. */
interface Candidate<T> {
	hit: T;
	signals: HitSignals;
	index: number;
	tokens: string[];
	creatorTokens: string[];
	lowerTitle: string;
	/** How well each query token is answered, title and creator best-of. */
	matches: number[];
}

/**
 * Orders a platform's page of hits, best answer first. The array is returned
 * reordered; nothing is added, removed or changed.
 */
export function rankHits<T extends { signals: HitSignals }>(
	hits: readonly T[],
	query: string,
): T[] {
	if (hits.length < 2) return [...hits];

	const queryTokens = [...new Set(tokenize(query))];
	const lowerQuery = query.toLowerCase();
	const notATrack = liftPatterns(NOT_A_TRACK, lowerQuery);
	const notTheTrack = liftPatterns(NOT_THE_TRACK, lowerQuery);
	// Only the first tier says anything about length: a query asking for a mix
	// or a full album is asking for something that runs long, where one asking
	// for an instrumental or a remix is not.
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

	// Each query token weighs what it discriminates by, measured on the page it
	// is ranking rather than against any corpus. A token every hit carries is a
	// token that separates none of them: a query naming an artist returns a page
	// where every entry names them too, so only the rest of the query can decide
	// which one it meant. Measuring it here needs no stopword list per language.
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

/** What the query left standing of the pattern tiers, and why it matters. */
interface Lifted {
	notATrack: readonly RegExp[];
	notTheTrack: readonly RegExp[];
	/** The query asked for long-running media, so length stops counting. */
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

	// The other direction of the same comparison: how much of the *creator's*
	// name the query spells out. That is what separates an artist's own upload
	// from the covers, remixes and remakes carrying the same title — they answer
	// the query's words just as well, and only the name behind them differs.
	// Measured over the creator's tokens rather than the query's, so naming the
	// artist counts fully however many other words the query holds.
	const named = candidate.creatorTokens.reduce(
		(sum, token) => sum + bestMatch(token, queryTokens),
		0,
	);
	const creator = candidate.creatorTokens.length
		? named / candidate.creatorTokens.length
		: 0;

	// The platform's own order, kept as a decaying prior rather than as a
	// tiebreak. Its judgement of what the query meant is the best single signal
	// on the page and is thrown away by re-sorting on anything else alone; what
	// it does not know is that it is answering a music player.
	const prior =
		PLATFORM_WEIGHT * (PLATFORM_HALF_LIFE / (PLATFORM_HALF_LIFE + candidate.index));

	return (
		RELEVANCE_WEIGHT * relevance +
		CREATOR_WEIGHT * creator +
		songAffinity(candidate, lifted) +
		prior
	);
}

/**
 * How much a hit looks like a song rather than something else that happens to
 * contain music, independent of what was searched for. Only ever a correction:
 * it orders hits the relevance can't tell apart, and cannot lift one over a hit
 * that answers the query better.
 */
function songAffinity<T>(
	candidate: Candidate<T>,
	{ notATrack, notTheTrack, queryWantsLongForm }: Lifted,
): number {
	const { signals } = candidate;
	let score = 0;

	// A "Topic" channel is auto-generated per artist and carries nothing but
	// their released tracks.
	if (signals.topicChannel) score += 3;
	// An "official" anything from a music search is the release itself.
	if (/\bofficial\b/.test(candidate.lowerTitle)) score += 2;
	if (signals.verified) score += 1;

	const { durationSec } = signals;
	if (durationSec === undefined) {
		score -= 4; // a live stream: no length, and nothing to download
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
