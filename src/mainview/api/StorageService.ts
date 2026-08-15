import { bun } from "./rpc";

export interface StorageState {
	/** Whether there is an install here to remove. Null until bun has answered. */
	removable: boolean | null;
	/** A failed check, or an uninstall bun turned down. */
	error: string | null;
	/** Set once the removal is under way, and never cleared — the app is going. */
	uninstalling: boolean;
}

/**
 * Whether VexWave can take itself off this machine, and the one action that
 * does it.
 *
 * Only bun can answer that: the webview knows neither where the app was
 * installed nor whether this copy is an installed one at all. Nothing here is
 * persisted or session-scoped — this is a fact about the computer, not about
 * the library.
 */
export class StorageService {
	private subscribers = new Set<() => void>();
	private snapshot: StorageState = {
		removable: null,
		error: null,
		uninstalling: false,
	};
	private checking = false;

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): StorageState => this.snapshot;

	/**
	 * Asks bun whether there is anything to remove. Called when the panel
	 * appears rather than at startup: the answer is only ever read there.
	 */
	check = async (): Promise<void> => {
		if (this.checking) return;
		this.checking = true;
		try {
			const result = await bun.canUninstall();
			if (!result.ok) {
				this.update({ removable: false, error: result.error });
				return;
			}
			this.update({ removable: result.removable, error: null });
		} catch (err) {
			this.update({
				removable: false,
				error:
					err instanceof Error ? err.message : "Couldn't reach the uninstaller",
			});
		} finally {
			this.checking = false;
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

/** App-wide singleton — the answer outlives a trip away from the panel. */
export const storageService = new StorageService();
