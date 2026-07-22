import type { RemoteArtist } from "../../shared/rpcSchema";

/** Combining diacritical marks, stripped after NFKD so "é" folds to "e". */
const DIACRITICS = /[̀-ͯ]/g;

/**
 * Fold an artist name to a comparison key that ignores the ways the same artist
 * is written differently across platforms: casing, diacritics, "&" vs "and",
 * and any surrounding punctuation, symbols or extra spacing. "Beyoncé",
 * "BEYONCE" and "beyoncé !" all normalize to "beyonce".
 *
 * Only punctuation is dropped, never letters: matching on `[^a-z0-9]` would
 * fold every non-Latin name ("米津玄師") to the empty string, which reads as
 * "no name to match" and re-creates that artist on every single import.
 */
function normalizeArtistName(name: string): string {
	return name
		.normalize("NFKD")
		.replace(DIACRITICS, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^\p{L}\p{N}]+/gu, " ") // punctuation/symbols → spaces
		.trim()
		.replace(/\s+/g, " ");
}

/** Levenshtein edit distance between two strings (rolling-row DP). */
function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	let curr = new Array<number>(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(
				prev[j] + 1, // deletion
				curr[j - 1] + 1, // insertion
				prev[j - 1] + cost, // substitution
			);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length];
}

/**
 * Find the artist in `artists` that most likely refers to the same person as
 * `name`. An identical normalized key wins outright (this is what collapses
 * casing, punctuation, diacritics and "&"/"and" differences). Otherwise, for
 * names long enough that closeness isn't coincidental, a small edit distance
 * still counts as a match — covering a typo or a stray character one platform
 * has and another doesn't. The closest such artist is returned, or null when
 * nothing is a confident match (kept conservative to avoid merging two genuinely
 * different artists).
 */
export function findMatchingArtist(
	name: string,
	artists: readonly RemoteArtist[],
): RemoteArtist | null {
	const target = normalizeArtistName(name);
	if (!target) return null;
	let best: RemoteArtist | null = null;
	let bestDist = Infinity;
	for (const artist of artists) {
		const candidate = normalizeArtistName(artist.name);
		if (!candidate) continue;
		if (candidate === target) return artist; // exact normalized match wins
		const maxLen = Math.max(candidate.length, target.length);
		if (maxLen < 5) continue; // too short for a fuzzy match to be trustworthy
		const dist = editDistance(candidate, target);
		// ≤15% of the longer string may differ (e.g. one edit in a 7-char name).
		if (dist / maxLen <= 0.15 && dist < bestDist) {
			best = artist;
			bestDist = dist;
		}
	}
	return best;
}
