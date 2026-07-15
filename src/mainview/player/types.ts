/**
 * A playable track. Every track streams from the backend: `src` is the bun
 * stream proxy's loopback http URL, which the webview's audio element plays
 * while the bun process attaches the session token and forwards the bytes.
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
