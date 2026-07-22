import { useSyncExternalStore } from "react";
import { trackCacheService } from "@/api/TrackCacheService";

/** Server ids of tracks whose full audio is cached bun-side (instant to play). */
export function useTrackCache(): ReadonlySet<number> {
	return useSyncExternalStore(
		trackCacheService.subscribe,
		trackCacheService.getSnapshot,
	);
}
