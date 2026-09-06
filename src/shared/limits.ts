// The contract's bounds, mirrored rather than imported: importing contract.ts
// would pull zod and Buffer into the browser bundle and hand the webview the
// backend address. The two base64 caps are checked against the real thing at
// startup (ApiClient), and are written in decoded form (4 base64 characters per
// 3 bytes) to stay comparable.
export const MAX_IMAGE_BYTES = ((10 * 1024 * 1024) / 4) * 3;
export const MAX_AUDIO_BYTES = ((100 * 1024 * 1024) / 4) * 3;

export const MAX_NAME_LENGTH = 200;
export const MAX_USERNAME_LENGTH = 64;
export const MAX_PASSWORD_LENGTH = 1024;
export const MAX_ARTISTS_PER_TRACK = 64;
export const MAX_TRACKS_PER_PLAYLIST = 5000;
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export function base64Length(bytes: number): number {
	return Math.ceil(bytes / 3) * 4;
}
