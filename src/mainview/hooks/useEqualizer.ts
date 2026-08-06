import { useSyncExternalStore } from "react";
import { playerController } from "@/hooks/usePlayer";
import type { Equalizer, EqualizerState } from "@/player/Equalizer";

/**
 * The equalizer in the playback graph. It belongs to the player singleton rather
 * than standing beside it — the settings and the audio nodes they drive are one
 * thing — so this hook reaches it through the controller instead of owning it.
 */
export function useEqualizer(): {
	state: EqualizerState;
	equalizer: Equalizer;
} {
	const equalizer = playerController.equalizer;
	const state = useSyncExternalStore(
		equalizer.subscribe,
		equalizer.getSnapshot,
	);
	return { state, equalizer };
}
