/**
 * A playable track. `src` is any URL the webview's audio element can play:
 * a blob: object URL for local files, or the bun stream proxy's loopback
 * http URL for server tracks.
 */
export interface Track {
	id: string;
	/**
	 * Where the track comes from — set by the loader that produced it.
	 * Consumers branch on this, never on the URL scheme of `src`.
	 */
	origin: "local" | "remote";
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
