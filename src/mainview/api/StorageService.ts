import type { StorageLocation } from "../../shared/rpcSchema";
import { bun } from "./rpc";

export interface StorageState {
	/** Null until the first measurement lands. */
	install: StorageLocation | null;
	components: StorageLocation | null;
	measured: boolean;
	/** A failed measurement, or an uninstall bun turned down. */
	error: string | null;
	/** Set once the removal is under way, and never cleared — the app is going. */
	uninstalling: boolean;
}

/**
 * What VexWave occupies on this machine, and the one action that removes it.
 *
 * Both directories are bun's to name: the webview knows neither where the app
 * was installed nor where its binaries were downloaded to, and measuring them
 * is a filesystem walk besides. Nothing here is persisted or session-scoped —
 * this is a fact about the computer, not about the library.
 */
export class StorageService {
	private subscribers = new Set<() => void>();
	private snapshot: StorageState = {
		install: null,
		components: null,
		measured: false,
		error: null,
		uninstalling: false,
	};
	private measuring = false;

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): StorageState => this.snapshot;

	/**
	 * Measures both directories. Called when the panel appears rather than at
	 * startup: the sizes are only ever read there, and walking a couple of
	 * gigabytes of app bundle is not work to do on every launch.
	 */
	refresh = async (): Promise<void> => {
		if (this.measuring) return;
		this.measuring = true;
		try {
			const result = await bun.getStorageUsage();
			if (!result.ok) {
				this.update({ measured: true, error: result.error });
				return;
			}
			this.update({
				install: result.install,
				components: result.components,
				measured: true,
				error: null,
			});
		} catch (err) {
			this.update({
				measured: true,
				error:
					err instanceof Error ? err.message : "Couldn't measure what's on disk",
			});
		} finally {
			this.measuring = false;
		}
	};

	/**
	 * Removes VexWave and closes it. Success leaves `uninstalling` set with
	 * nothing to return to: the window is about to go, and the panel spends its
	 * last moment saying so rather than pretending the button is live again.
	 */
	uninstall = async (): Promise<void> => {
		if (this.snapshot.uninstalling) return;
		this.update({ uninstalling: true, error: null });
		try {
			const result = await bun.uninstallApp();
			if (!result.ok) this.update({ uninstalling: false, error: result.error });
		} catch (err) {
			this.update({
				uninstalling: false,
				error:
					err instanceof Error ? err.message : "The uninstall never started",
			});
		}
	};

	private update(patch: Partial<StorageState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — a measurement outlives a trip away from the panel. */
export const storageService = new StorageService();
