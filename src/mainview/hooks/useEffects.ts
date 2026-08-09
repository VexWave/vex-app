import { useSyncExternalStore } from "react";
import { playerController } from "@/hooks/usePlayer";
import type { Effects, EffectsState } from "@/player/Effects";

/**
 * Playback speed and reverb. These belong to the player singleton, as the
 * equalizer does — the settings and what they drive, an element property and a
 * branch of the audio graph, are one thing — so this hook reaches them through
 * the controller.
 */
export function useEffects(): {
	state: EffectsState;
	effects: Effects;
} {
	const effects = playerController.effects;
	const state = useSyncExternalStore(effects.subscribe, effects.getSnapshot);
	return { state, effects };
}
