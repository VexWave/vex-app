import { playerController } from "@/hooks/usePlayer";
import { storage } from "@/lib/storage";
import type { PlayerState } from "@/player/types";
import type { PresenceStatus, PresenceTrack } from "../../shared/rpcSchema";
import { bun, notifyBun, onBunMessage } from "./rpc";

/**
 * Feeds what the player is doing to the bun process, which publishes it as
 * Discord Rich Presence (`src/bun/DiscordPresence.ts`), and owns the switch that
 * decides whether any of it happens.
 *
 * The filtering is why it stands between the two. The player notifies on every
 * `timeupdate`, several times a second, while Discord accepts a handful of
 * updates per minute; pushing each one would be pure waste even before its rate
 * limit. So only changes Discord would actually render are forwarded — and
 * because logging out clears the queue, the presence comes down with it, nothing
 * here having to know about sessions.
 *
 * A track is forwarded only while it is *playing*; `null` says there is no
 * presence to show at all. Paused is not a state the presence has: audio that
 * isn't sounding is the same to a reader as audio that was never started, so a
 * pause takes the card down and the track comes back when it resumes.
 *
 * The switch is the app's, not bun's: it is a user preference, and localStorage
 * is where those live. Bun keeps no copy, so it is told where the switch stands
 * at startup as well as whenever it moves.
 */

/**
 * How far Discord's progress bar may drift from the true position before a
 * correction is worth sending. Discord advances the bar itself from the
 * timestamps it was handed, so ordinary playback needs no updates at all: only
 * a seek moves the position away from where the bar already is.
 */
const DRIFT_TOLERANCE_SEC = 2;

export interface PresenceState {
	enabled: boolean;
	/** Where bun's end of the integration stands, as the panel reports it. */
	status: PresenceStatus;
}

export class PresenceService {
	private subscribers = new Set<() => void>();
	private snapshot: PresenceState = {
		enabled: storage.discord.presenceEnabled.get() ?? true,
		status: { connection: "offline" },
	};
	/** The last state pushed, and when — the baseline the bar has advanced from. */
	private sent: PresenceTrack | null = null;
	private sentAt = 0;

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): PresenceState => this.snapshot;

	/**
	 * Starts mirroring the player into Discord. Call once at startup; the
	 * subscription lives as long as the app does.
	 */
	start(): void {
		// Where the switch stands is the first thing bun hears — nothing connects
		// to Discord until it does.
		void this.announce(this.snapshot.enabled);
		// An opening push resyncs a bun process that outlived the webview — a dev
		// HMR reload restarts this side while the presence keeps whatever track it
		// was last told about.
		this.publishNow();
		playerController.subscribe(() => {
			if (!this.snapshot.enabled) return;
			const next = presenceFor(playerController.getSnapshot());
			if (this.hasChanged(next)) this.push(next);
		});
	}

	setEnabled = (enabled: boolean): void => {
		if (enabled === this.snapshot.enabled) return;
		storage.discord.presenceEnabled.set(enabled);
		this.update({ enabled });
		void this.announce(enabled);
		// Whatever bun was last told went stale while the switch was off, so the
		// way back on states the track again rather than trusting it. Nothing is
		// sent on the way off: dropping the connection is what clears the card.
		this.sent = null;
		if (enabled) this.publishNow();
	};

	/**
	 * A change bun made on its own — Discord came, went, or turned an update
	 * down.
	 */
	handleStatus(status: PresenceStatus): void {
		this.update({ status });
	}

	/**
	 * Hands the switch to bun and takes the connection it answers with. A
	 * request, where the track updates are pushed: those are corrected by the
	 * next one, while a switch that failed to arrive would leave bun disagreeing
	 * with the panel until the user touched it again — so this one is waited on,
	 * and a failure to deliver it says so instead of passing for "off".
	 */
	private async announce(enabled: boolean): Promise<void> {
		try {
			this.update({ status: await bun.setPresenceEnabled({ enabled }) });
		} catch (err) {
			this.update({ status: { connection: "offline" } });
			console.error("Discord presence: bun never took the setting.", err);
		}
	}

	private publishNow(): void {
		if (!this.snapshot.enabled) return;
		this.push(presenceFor(playerController.getSnapshot()));
	}

	private push(next: PresenceTrack | null): void {
		this.sent = next;
		this.sentAt = Date.now();
		notifyBun.presenceChanged({ track: next });
	}

	private hasChanged(next: PresenceTrack | null): boolean {
		// Covers both ends of a transition, and nothing→nothing (no change at all).
		if (!next || !this.sent) return next !== this.sent;
		if (
			next.id !== this.sent.id ||
			next.title !== this.sent.title ||
			next.artist !== this.sent.artist ||
			next.hasCover !== this.sent.hasCover ||
			// Backfilled once the audio element reports it, which turns the elapsed
			// timer into a real progress bar.
			next.durationSec !== this.sent.durationSec
		) {
			return true;
		}
		// Where Discord's bar has reached by now, given what it was last told —
		// anything sent is playing, so the bar has been running since. A position
		// that no longer matches it is a seek.
		const expectedSec =
			this.sent.positionSec + (Date.now() - this.sentAt) / 1000;
		return Math.abs(next.positionSec - expectedSec) > DRIFT_TOLERANCE_SEC;
	}

	private update(patch: Partial<PresenceState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

function presenceFor(state: PlayerState): PresenceTrack | null {
	const track = state.currentTrack;
	// A track loaded but stopped — paused, or preloaded by `syncCollection` and
	// never started — is nothing to advertise.
	if (!track || !state.isPlaying) return null;
	return {
		id: track.id,
		title: track.title,
		artist: track.artist,
		hasCover: track.coverUrl !== undefined,
		// Whole seconds is all Discord renders, and it keeps the float noise of
		// the audio element's clock out of the comparison above.
		positionSec: Math.round(state.currentTimeSec),
		durationSec: Math.round(state.durationSec),
	};
}

/** App-wide singleton — the presence follows the player, not what is on screen. */
export const presenceService = new PresenceService();

onBunMessage("presenceStatus", (status) => {
	presenceService.handleStatus(status);
});
