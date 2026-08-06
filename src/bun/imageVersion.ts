import { convertQueryParamsToUrlString } from "@ts-rest/core";

/**
 * The query parameter the contract's image paths carry a content version in.
 * Named once because the app both writes it — onto a stream-proxy URL — and
 * reads it back, off a listing URL and off an incoming proxy request. A
 * spelling that drifted between those breaks nothing visibly: the right bytes
 * still arrive, they just go back to being read from the database every time.
 */
const VERSION_PARAM = "v";

/**
 * The content version pinned on an image URL, or undefined when it names none.
 *
 * Only the query is parsed, and with `URLSearchParams` rather than `URL`: the
 * server sends a path, and the contract types it as a bare string, so a value
 * `URL` refuses to parse (`//`, `http://`) is a shape this can be handed. That
 * has to cost the caller no more than an unversioned image — throwing here
 * would report a whole library as unreachable over one cosmetic field.
 *
 * An empty version is no version. It would otherwise travel on as a bare `?v=`,
 * which is a second cache key that pins nothing.
 */
export function imageVersion(url: string): string | undefined {
	const query = url.indexOf("?");
	if (query === -1) return undefined;
	return new URLSearchParams(url.slice(query + 1)).get(VERSION_PARAM) || undefined;
}

/**
 * `?v=…` for a pinned image URL; nothing when no version was named. The encoder
 * the contract's own image paths use, so a version means the same string on
 * both sides of the loopback hop however it is spelled.
 */
export function versionQuery(version: string | undefined): string {
	return convertQueryParamsToUrlString({ [VERSION_PARAM]: version });
}
