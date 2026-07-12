import { parseBlob } from "music-metadata";
import type { Track } from "./types";

/**
 * Turns Files picked from the computer into Tracks: creates blob object
 * URLs for playback and reads ID3/metadata tags (title, artist, album,
 * duration, embedded cover art) with graceful fallbacks.
 */
export class LocalTrackLoader {
	async loadFiles(files: Iterable<File>): Promise<Track[]> {
		const audioFiles = [...files].filter(
			(file) => file.type.startsWith("audio/") || file.type === "video/mp4",
		);
		return Promise.all(audioFiles.map((file) => this.loadFile(file)));
	}

	private async loadFile(file: File): Promise<Track> {
		const track: Track = {
			id: crypto.randomUUID(),
			title: file.name.replace(/\.[^.]+$/, ""),
			durationSec: 0,
			src: URL.createObjectURL(file),
		};

		try {
			const metadata = await parseBlob(file);
			const { common, format } = metadata;
			if (common.title) track.title = common.title;
			if (common.artist) track.artist = common.artist;
			if (common.album) track.album = common.album;
			if (format.duration) track.durationSec = format.duration;
			const picture = common.picture?.[0];
			if (picture) {
				const blob = new Blob([picture.data as BlobPart], {
					type: picture.format,
				});
				track.coverUrl = URL.createObjectURL(blob);
			}
		} catch {
			// Unreadable/absent tags — keep filename title; the AudioPlayer
			// reports the real duration once the file is loaded.
		}

		return track;
	}

	/** Release the object URLs backing a local track. */
	static dispose(track: Track): void {
		if (track.src.startsWith("blob:")) URL.revokeObjectURL(track.src);
		if (track.coverUrl?.startsWith("blob:")) {
			URL.revokeObjectURL(track.coverUrl);
		}
	}
}
