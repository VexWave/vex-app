import { useMemo } from "react";
import { ListMusic } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RemotePlaylist } from "../../shared/rpcSchema";
import type { Track } from "@/player/types";

/**
 * A playlist's cover: the uploaded image when it has one, else a collage of
 * the first (up to four) distinct track covers — 1 fills the square, 2 sit
 * side by side, 3 are two on top and one across the bottom, 4 take a corner
 * each. The collage needs no server round-trip — it reuses cover URLs the
 * library already has.
 */
export function PlaylistCover({
	playlist,
	tracks,
	className,
	iconClassName,
}: {
	playlist: RemotePlaylist;
	tracks: Track[];
	className?: string;
	iconClassName?: string;
}) {
	const covers = useMemo(() => {
		if (playlist.imageUrl) return [];
		const distinct: string[] = [];
		for (const track of tracks) {
			if (track.coverUrl && !distinct.includes(track.coverUrl)) {
				distinct.push(track.coverUrl);
				if (distinct.length === 4) break;
			}
		}
		return distinct;
	}, [playlist.imageUrl, tracks]);

	return (
		<div
			className={cn(
				"relative overflow-hidden rounded-md bg-muted shadow-sm ring-1 ring-inset ring-border/60",
				className,
			)}
		>
			{playlist.imageUrl ? (
				<img
					src={playlist.imageUrl}
					alt=""
					className="h-full w-full object-cover"
				/>
			) : covers.length === 1 ? (
				<img src={covers[0]} alt="" className="h-full w-full object-cover" />
			) : covers.length > 1 ? (
				// 2 covers → side-by-side halves; 3 → two on top, one across the
				// bottom; 4 → one per corner.
				<div
					className={cn(
						// Explicit fr rows — the images size themselves h-full against
						// the row track, which an implicit `auto` row can't provide.
						"grid h-full w-full grid-cols-2",
						covers.length >= 3 ? "grid-rows-2" : "grid-rows-1",
					)}
				>
					{covers.map((url, index) => (
						<img
							key={url}
							src={url}
							alt=""
							className={cn(
								"h-full w-full object-cover",
								covers.length === 3 && index === 2 && "col-span-2",
							)}
						/>
					))}
				</div>
			) : (
				<ListMusic
					className={cn(
						"absolute inset-0 m-auto text-muted-foreground",
						iconClassName ?? "h-8 w-8",
					)}
				/>
			)}
		</div>
	);
}
