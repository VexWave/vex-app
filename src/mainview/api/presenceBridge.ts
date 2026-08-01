import { playerController } from "@/hooks/usePlayer";
import type { PlayerState } from "@/player/types";
import type { PresenceTrack } from "../../shared/rpcSchema";
import { notifyBun } from "./rpc";

/**
 * Feeds what the player is doing to the bun process, which publishes it as
 * Discord Rich Presence (`src/bun/DiscordPresence.ts`).
 *
 * Not a service in the sense the rest of `api/` is — it holds no state the UI
 * renders and has no hook. It exists to keep the filtering below out of the
 * player core, which stays free of anything RPC-shaped.
 *
 * The filtering is the point. The player notifies on every `timeupdate`,
 * several times a second, while Discord accepts a handful of updates per
 * minute; pushing each one would be pure waste even before its rate limit. So
 * only changes Discord would actually render are forwarded — and because
 * logging out clears the queue, the idle card follows from that with nothing
 * here having to know about sessions.
 *
 * A track is forwarded only while it is *playing*. Paused is not a state the
 * presence has: audio that isn't sounding is the same to a reader as audio that
 * was never started, so a pause reads as idle and the track comes back when it
 * resumes.
 */

/**
 * How far Discord's progress bar may drift from the true position before a
 * correction is worth sending. Discord advances the bar itself from the
 * timestamps it was handed, so ordinary playback needs no updates at all: only
 * a seek moves the position away from where the bar already is.
 */
const DRIFT_TOLERANCE_SEC = 2;

/** The last state pushed, and when — the baseline the bar has advanced from. */
let sent: PresenceTrack | null = null;
let sentAt = 0;

/**
 * Starts mirroring the player into Discord. Call once at startup; the
 * subscription lives as long as the app does.
 */
export function startPresenceBridge(): void {
	// An opening push resyncs a bun process that outlived the webview — a dev
	// HMR reload restarts this side while the presence keeps whatever track it
	// was last told about.
	push(presenceFor(playerController.getSnapshot()));
	playerController.subscribe(() => {
		const next = presenceFor(playerController.getSnapshot());
		if (hasChanged(next)) push(next);
	});
}

function push(next: PresenceTrack | null): void {
	sent = next;
	sentAt = Date.now();
	notifyBun.presenceChanged({ track: next });
}

function presenceFor(state: PlayerState): PresenceTrack | null {
	const track = state.currentTrack;
	// A track loaded but stopped — paused, or preloaded by `syncCollection` and
	// never started — is idle as far as the presence is concerned.
	if (!track || !state.isPlaying) return null;
	return {
		id: track.id,
		title: track.title,
		artist: track.artist,
		hasCover: track.coverUrl !== undefined,
		// Whole seconds is all Discord renders, and it keeps the float noise of
		// the audio element's clock out of the comparison below.
		positionSec: Math.round(state.currentTimeSec),
		durationSec: Math.round(state.durationSec),
	};
}

function hasChanged(next: PresenceTrack | null): boolean {
	// Covers idle→idle (nothing changed) and either side of a transition.
	if (!next || !sent) return next !== sent;
	if (
		next.id !== sent.id ||
		next.title !== sent.title ||
		next.artist !== sent.artist ||
		next.hasCover !== sent.hasCover ||
		// Backfilled once the audio element reports it, which turns the elapsed
		// timer into a real progress bar.
		next.durationSec !== sent.durationSec
	) {
		return true;
	}
	// Where Discord's bar has reached by now, given what it was last told —
	// anything sent is playing, so the bar has been running since. A position
	// that no longer matches it is a seek.
	const expectedSec = sent.positionSec + (Date.now() - sentAt) / 1000;
	return Math.abs(next.positionSec - expectedSec) > DRIFT_TOLERANCE_SEC;
}
