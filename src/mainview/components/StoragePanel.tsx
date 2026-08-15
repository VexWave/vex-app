import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Group, SettingRow } from "@/components/SettingsControls";
import { Button } from "@/components/ui/button";
import { useStorage } from "@/hooks/useStorage";

/** The way to take VexWave off the machine, and nothing else. */
export function StoragePanel() {
	const { storage, service } = useStorage();
	const [confirming, setConfirming] = useState(false);

	useEffect(() => {
		void service.check();
	}, [service]);

	// Nothing at all until bun has said there is something to remove: a row that
	// appears and then retracts is worse than one that arrives a moment late.
	if (!storage.removable) return null;

	return (
		<>
			<Group
				title="Uninstall"
				description="Take VexWave off this computer."
			>
				<SettingRow
					label="Delete VexWave"
					hint={storage.error ?? undefined}
					control={(labelling) => (
						<Button
							variant="destructive"
							size="sm"
							disabled={storage.uninstalling}
							onClick={() => setConfirming(true)}
							{...labelling}
						>
							{storage.uninstalling ? "Closing…" : "Delete"}
						</Button>
					)}
				/>
			</Group>

			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Delete VexWave?"
				description="This removes the player, everything it downloaded to run — its browser engine, yt-dlp, ffmpeg — and its shortcuts, then closes. Your library stays on the server."
				confirmLabel="Delete VexWave"
				onConfirm={() => void service.uninstall()}
			/>
		</>
	);
}
