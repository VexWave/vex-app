import type {
	BinaryInstallStep,
	BinaryName,
	BinaryProgressMessage,
} from "../../shared/rpcSchema";
import { bun, onBunMessage } from "./rpc";

export type BinaryPhase =
	| "checking"
	| "missing"
	| "installing"
	| "ready"
	| "error";

export interface BinaryProgressInfo {
	step: BinaryInstallStep;
	receivedBytes: number;
	/** null = server sent no content-length (indeterminate bar). */
	totalBytes: number | null;
	part: number;
	partCount: number;
	done: boolean;
}

/** Immutable snapshot of the managed-binaries state for the React layer. */
export interface BinariesState {
	phase: BinaryPhase;
	missing: BinaryName[];
	/** Per-binary progress while phase === "installing". */
	progress: Partial<Record<BinaryName, BinaryProgressInfo>>;
	/** Fatal status/install error shown on the blocking setup screen. */
	error: string | null;

	// yt-dlp update hint (non-blocking banner in the player UI)
	updateAvailable: boolean;
	latestVersion: string | null;
	updating: boolean;
	updateProgress: BinaryProgressInfo | null;
	updateError: string | null;
	updateDismissed: boolean;
}

/**
 * Tracks the externally downloaded binaries (yt-dlp, ffmpeg, deno) that the
 * bun-side BinaryManager owns. The blocking setup screen renders off `phase`;
 * the yt-dlp update banner renders off the `update*` fields. Install/update
 * RPCs only start bun-side runs — progress and completion arrive as pushed
 * `binaryProgress` messages.
 */
export class BinaryService {
	private subscribers = new Set<() => void>();
	private snapshot: BinariesState = {
		phase: "checking",
		missing: [],
		progress: {},
		error: null,
		updateAvailable: false,
		latestVersion: null,
		updating: false,
		updateProgress: null,
		updateError: null,
		updateDismissed: false,
	};
	private updateCheckDone = false;

	// --- useSyncExternalStore contract (arrow fns keep `this` bound) ---

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): BinariesState => this.snapshot;

	/** Disk-only status poll; flips the gate to "ready" or "missing". */
	async refreshStatus(): Promise<void> {
		let result;
		try {
			result = await bun.getBinaryStatus();
		} catch (err) {
			this.update({
				phase: "error",
				error: err instanceof Error ? err.message : "Binary check failed",
			});
			return;
		}
		if (!result.ok) {
			this.update({ phase: "error", error: result.error });
			return;
		}
		if (result.missing.length === 0) {
			this.update({ phase: "ready", missing: [], progress: {}, error: null });
			// One best-effort check per app run, once the binaries exist.
			if (!this.updateCheckDone) {
				this.updateCheckDone = true;
				void this.checkForUpdate();
			}
		} else {
			this.update({ phase: "missing", missing: result.missing, error: null });
		}
	}

	/** Kicks off the bun-side install of everything currently missing. */
	async install(): Promise<void> {
		const { phase, missing } = this.snapshot;
		if (phase !== "missing" && phase !== "error") return;
		const progress: BinariesState["progress"] = {};
		for (const binary of missing) {
			progress[binary] = {
				step: "downloading",
				receivedBytes: 0,
				totalBytes: null,
				part: 1,
				partCount: 1,
				done: false,
			};
		}
		this.update({ phase: "installing", progress, error: null });
		try {
			const result = await bun.installMissingBinaries();
			if (!result.ok) this.update({ phase: "error", error: result.error });
		} catch (err) {
			this.update({
				phase: "error",
				error: err instanceof Error ? err.message : "Install failed to start",
			});
		}
	}

	/** Re-check what's still missing, then install just that. */
	async retry(): Promise<void> {
		await this.refreshStatus();
		if (this.snapshot.phase === "missing") await this.install();
	}

	async updateYtDlp(): Promise<void> {
		if (this.snapshot.updating) return;
		this.update({ updating: true, updateError: null, updateProgress: null });
		try {
			const result = await bun.updateYtDlp();
			if (!result.ok) this.update({ updating: false, updateError: result.error });
		} catch (err) {
			this.update({
				updating: false,
				updateError: err instanceof Error ? err.message : "Update failed to start",
			});
		}
	}

	/** Best-effort; bun already swallows offline/rate-limit failures. */
	async checkForUpdate(): Promise<void> {
		try {
			const result = await bun.checkYtDlpUpdate();
			if (result.updateAvailable) {
				this.update({
					updateAvailable: true,
					latestVersion: result.latestVersion ?? null,
				});
			}
		} catch {
			// Silent — the hint is optional.
		}
	}

	/** Hides the update banner for the rest of this app run. */
	dismissUpdate(): void {
		this.update({ updateDismissed: true });
	}

	/**
	 * Routes by phase, not binary name: during the blocking install the
	 * messages drive the setup screen; otherwise a run can only be the
	 * user-triggered yt-dlp update, which drives the banner.
	 */
	handleProgress(msg: BinaryProgressMessage): void {
		if (this.snapshot.phase === "installing") {
			switch (msg.type) {
				case "progress":
					this.update({
						progress: {
							...this.snapshot.progress,
							[msg.binary]: {
								step: msg.step,
								receivedBytes: msg.receivedBytes,
								totalBytes: msg.totalBytes ?? null,
								part: msg.part,
								partCount: msg.partCount,
								done: false,
							},
						},
					});
					break;
				case "binaryInstalled": {
					const existing = this.snapshot.progress[msg.binary];
					if (!existing) break;
					this.update({
						progress: {
							...this.snapshot.progress,
							[msg.binary]: { ...existing, done: true },
						},
					});
					break;
				}
				case "finished":
					// The disk status is the source of truth for opening the gate.
					void this.refreshStatus();
					break;
				case "failed":
					this.update({ phase: "error", error: msg.error });
					break;
			}
			return;
		}
		switch (msg.type) {
			case "progress":
				this.update({
					updateProgress: {
						step: msg.step,
						receivedBytes: msg.receivedBytes,
						totalBytes: msg.totalBytes ?? null,
						part: msg.part,
						partCount: msg.partCount,
						done: false,
					},
				});
				break;
			case "finished":
				this.update({
					updating: false,
					updateAvailable: false,
					updateProgress: null,
				});
				break;
			case "failed":
				this.update({
					updating: false,
					updateProgress: null,
					updateError: msg.error,
				});
				break;
		}
	}

	private update(patch: Partial<BinariesState>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.subscribers.forEach((notify) => notify());
	}
}

/** App-wide singleton — install progress must survive component unmounts. */
export const binaryService = new BinaryService();

onBunMessage("binaryProgress", (msg) => {
	binaryService.handleProgress(msg);
});

// Startup disk check: decides whether the blocking setup screen appears.
void binaryService.refreshStatus();
