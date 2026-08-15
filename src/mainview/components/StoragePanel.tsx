import { useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Group, SettingRow } from "@/components/SettingsControls";
import { Button } from "@/components/ui/button";
import { useStorage } from "@/hooks/useStorage";
import type { StorageLocation } from "../../shared/rpcSchema";

/**
 * Where VexWave keeps itself, and the way to take it off the machine.
 *
 * The two directories are the panel's subject as much as the button is: an app
 * that installs itself into `%LOCALAPPDATA%` under a name the user never chose,
 * and downloads a few hundred megabytes of tooling beside it, owes them the
 * paths and the sizes whether or not they ever press anything.
 */
export function StoragePanel() {
	const { storage, service } = useStorage();
	const [confirming, setConfirming] = useState(false);

	useEffect(() => {
		void service.refresh();
	}, [service]);

	// An install measured is an install this copy is entitled to remove — bun
	// answers null for a development build, whose channel folder holds a browser
	// cache rather than the app running out of it.
	const removable = storage.install !== null;
	const total = (storage.install?.bytes ?? 0) + (storage.components?.bytes ?? 0);

	return (
		<>
			<Group
				title="Storage"
				description="Where VexWave keeps itself on this computer."
			>
				<SettingRow
					label="Player"
					hint={
						<Where
							location={storage.install}
							measured={storage.measured}
							absent="Running from a development build, which isn't installed here."
						>
							Every version installed: the app, its browser engine, and the
							installer it unpacked itself from.
						</Where>
					}
					control={() => <Size location={storage.install} />}
				/>
				<SettingRow
					label="Components"
					hint={
						<Where
							location={storage.components}
							measured={storage.measured}
							absent="Nothing downloaded yet."
						>
							yt-dlp, ffmpeg, and finished URL imports.
						</Where>
					}
					control={() => <Size location={storage.components} />}
				/>

				{storage.error && (
					<SettingRow label="That didn't work" hint={storage.error} />
				)}

				{removable && (
					<SettingRow
						label="Delete VexWave"
						hint="Removes both folders and closes the app. Your library stays on the server."
						control={(labelling) => (
							<Button
								variant="destructive"
								size="sm"
								disabled={storage.uninstalling}
								onClick={() => setConfirming(true)}
								{...labelling}
							>
								{storage.uninstalling ? "Closing…" : "Delete VexWave"}
							</Button>
						)}
					/>
				)}
			</Group>

			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Delete VexWave?"
				description={`This removes ${formatBytes(total)} from this computer and closes the app. Your library stays on the server.`}
				confirmLabel="Delete VexWave"
				onConfirm={() => void service.uninstall()}
			/>
		</>
	);
}

/**
 * A directory's path above the sentence explaining it. The path is set in mono
 * and given the first line because it is the row's real content — a user about
 * to delete something is owed the exact name of it, not a description of it.
 */
function Where({
	location,
	measured,
	absent,
	children,
}: {
	location: StorageLocation | null;
	measured: boolean;
	/** Why there is no path to show, once the measurement has come back. */
	absent: string;
	children: ReactNode;
}) {
	if (!location) return <>{measured ? absent : "Measuring…"}</>;
	return (
		<>
			<span className="block break-all font-mono text-foreground/70">
				{location.path}
			</span>
			<span className="mt-0.5 block">{children}</span>
		</>
	);
}

function Size({ location }: { location: StorageLocation | null }) {
	if (!location) return null;
	return (
		<span className="text-sm tabular-nums text-muted-foreground">
			{formatBytes(location.bytes)}
		</span>
	);
}

/**
 * Sizes here run from a few megabytes to a few gigabytes, so the unit moves and
 * one decimal is enough at every step of it.
 */
function formatBytes(bytes: number): string {
	const gb = bytes / 1e9;
	if (gb >= 1) return `${gb.toFixed(1)} GB`;
	return `${Math.round(bytes / 1e6)} MB`;
}
