import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Group } from "@/components/SettingsControls";
import { Button } from "@/components/ui/button";
import { useUninstall } from "@/hooks/useUninstall";

/**
 * The way to take VexWave off the machine, and nothing else. One row: the
 * button belongs to the panel rather than to any setting in it, so it sits in
 * the header and the panel draws no rows at all.
 */
export function UninstallPanel() {
	const { uninstall, service } = useUninstall();
	const [confirming, setConfirming] = useState(false);

	useEffect(() => {
		void service.check();
	}, [service]);

	// Nothing at all until bun has said there is something to remove: a row that
	// appears and then retracts is worse than one that arrives a moment late.
	if (!uninstall.removable) return null;

	return (
		<>
			<Group
				title="Uninstall"
				// The header's own line is where a refusal goes, there being no row
				// under it to carry one.
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
