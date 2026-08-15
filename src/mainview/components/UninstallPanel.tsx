import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Group } from "@/components/SettingsControls";
import { Button } from "@/components/ui/button";
import { useUninstall } from "@/hooks/useUninstall";

/**
 * Takes VexWave off the machine. One row: the button governs the panel rather
 * than a setting in it, so it sits in the header and there are no rows.
 */
export function UninstallPanel() {
	const { uninstall, service } = useUninstall();
	const [confirming, setConfirming] = useState(false);

	useEffect(() => {
		void service.check();
	}, [service]);

	// Nothing until bun answers: a row that appears and retracts is worse than
	// one that arrives a moment late.
	if (!uninstall.removable) return null;

	return (
		<>
			<Group
				title="Uninstall"
				// No row under it to carry a refusal.
				description={uninstall.error ?? "Take VexWave off this computer."}
				action={(labelling) => (
					<Button
						variant="destructive"
						size="sm"
						disabled={uninstall.running}
						onClick={() => setConfirming(true)}
						{...labelling}
					>
						{uninstall.running ? "Closing…" : "Delete VexWave"}
					</Button>
				)}
			/>

			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Delete VexWave?"
				description="This removes the player, everything it downloaded to run (its browser engine, yt-dlp and ffmpeg) and its shortcuts, then closes. Your library stays on the server."
				confirmLabel="Delete VexWave"
				onConfirm={() => void service.uninstall()}
			/>
		</>
	);
}
