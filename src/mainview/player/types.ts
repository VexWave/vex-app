/**
 * A playable track. `src` is any URL the webview's audio element can play:
 * today a blob: object URL for local files, later an http(s) URL served by
 * the backend API.
 */
export interface Track {
	id: string;
	title: string;
	artist?: string;
	album?: string;
	/** Duration in seconds; 0 when not yet known. */
	durationSec: number;
	coverUrl?: string;
	src: string;
}

export type RepeatMode = "off" | "all" | "one";

/** Immutable snapshot of the whole player, consumed by the React layer. */
export interface PlayerState {
	tracks: readonly Track[];
	currentTrack: Track | null;
	currentIndex: number;
	isPlaying: boolean;
	currentTimeSec: number;
	durationSec: number;
	volume: number;
	muted: boolean;
	repeatMode: RepeatMode;
	error: string | null;
}
