// The bounds `contract/contract.ts` enforces, in the units the client checks
// against: decoded bytes rather than base64 length, and plain character counts.
//
// They are mirrored here rather than imported because the webview is the side
// that needs them — importing the contract would pull zod and `Buffer` into the
// browser bundle, and hand the webview knowledge of a backend it is otherwise
// kept ignorant of. The contract exports only its two base64 caps, so those two
// are checked against the real thing at startup (`ApiClient`); the rest have no
// exported counterpart to check. Exporting them from the contract would let
// this file import them instead.

/**
 * Decoded payload ceilings, written as the decoded form of the same expression
 * the contract states them in (base64 costs 4 characters per 3 bytes), so a
 * change on either side shows up as a different number rather than hiding
 * inside a conversion.
 */
export const MAX_IMAGE_BYTES = ((10 * 1024 * 1024) / 4) * 3; // 7.5 MiB
export const MAX_AUDIO_BYTES = ((100 * 1024 * 1024) / 4) * 3; // 75 MiB

/** Every user-facing name: track titles, artist names, playlist names. */
export const MAX_NAME_LENGTH = 200;
export const MAX_USERNAME_LENGTH = 64;
export const MAX_PASSWORD_LENGTH = 1024;
export const MAX_ARTISTS_PER_TRACK = 64;
export const MAX_TRACKS_PER_PLAYLIST = 5000;
/** A sanity bound rather than a real limit: 24 hours in milliseconds. */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** Characters `bytes` bytes occupy once base64-encoded, padding included. */
export function base64Length(bytes: number): number {
	return Math.ceil(bytes / 3) * 4;
}
