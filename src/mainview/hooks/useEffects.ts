import { useSyncExternalStore } from "react";
import { playerController } from "@/hooks/usePlayer";
import type { Effects, EffectsState } from "@/player/Effects";

/**
 * Playback speed and reverb. Like the equalizer these belong to the player
 * singleton rather than standing beside it — the settings and what they drive,
 * an element property and a pair of audio nodes, are one thing — so this hook
 * reaches them through the controller instead of owning them.
 */
export function useEffects(): {
	state: EffectsState;
	effects: Effects;
} {
	const effects = playerController.effects;
	const state = useSyncExternalStore(effects.subscribe, effects.getSnapshot);
	return { state, effects };
}
