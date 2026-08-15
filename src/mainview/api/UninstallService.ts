import { bun } from "./rpc";

export interface UninstallState {
	/** Whether there is an install here to remove. Null until bun has answered. */
	removable: boolean | null;
	/** An uninstall bun turned down. Nothing else here reaches the screen. */
	error: string | null;
	/** Set once the removal is under way, and never cleared: the app is going. */
	running: boolean;
}

/**
 * Whether VexWave can take itself off this machine, and the action that does
 * it. Only bun can answer: the webview knows neither where the app was
 * installed nor whether this copy is an installed one at all.
 */
export class UninstallService {
	private subscribers = new Set<() => void>();
	private snapshot: UninstallState = {
		removable: null,
		error: null,
		running: false,
	};
	private checking = false;

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): UninstallState => this.snapshot;

	/**
	 * Asked when the panel appears, and once for the run: an install doesn't
	 * become a development build while the app is open.
	 */
	check = async (): Promise<void> => {
		if (this.checking || this.snapshot.removable !== null) return;
		this.checking = true;
		try {
			const { removable } = await bun.canUninstall();
			this.update({ removable });
		} catch {
			// A panel that can't ask has nothing to offer either.
			this.update({ removable: false });
		} finally {
			this.checking = false;
		}
	};

	/**
	 * Removes VexWave and closes it. `running` stays set on success: the window
	 * is about to go, and the button has nothing to return to.
	 */
	uninstall = async (): Promise<void> => {
		if (this.snapshot.running) return;
		this.update({ running: true, error: null });
		try {
			const result = await bun.uninstallApp();
			if (!result.ok) this.update({ running: false, error: result.error });
		} catch (err) {
			this.update({
				running: false,
				error:
					err instanceof Error ? err.message : "The uninstall never started",
			});
		}
	};

	private update(patch: Partial<UninstallState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — the answer outlives a trip away from the panel. */
export const uninstallService = new UninstallService();
