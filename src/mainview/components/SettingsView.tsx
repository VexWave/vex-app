import { DiscordPanel } from "@/components/DiscordPanel";
import { EqualizerPanel } from "@/components/EqualizerPanel";
import { StoragePanel } from "@/components/StoragePanel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

/**
 * The app's preferences — the equalizer and the Discord presence — and, at the
 * bottom, what it occupies on the machine. It stands in its own section rather
 * than in a dialog because settings are a place to be, not an interruption —
 * and like Discover it declares no aside (see `components/Sections`), so its
 * column is centred in the window it takes rather than pushed against a
 * sidebar.
 *
 * A setting added here is a `Group` from `SettingsControls` — of `SettingRow`s
 * where it has more to say than the switch in its header — with its key declared
 * in `lib/storage` and its state kept beside whatever it configures: a service
 * under `api/` for most things, the playback core for the equalizer.
 *
 * Not every setting belongs here. What is reached for while listening, because it
 * belongs to the track playing rather than to the app, is in the player bar
 * instead (`PlaybackEffects`).
 */
export function SettingsView() {
	return (
		<div className="flex h-full flex-col">
			{/* The same plain heading every view wears — the switch already names
			    this one in the app bar, glyph and all. */}
			<div className="flex items-center gap-3 px-4 py-2.5">
				<h2 className="shrink-0 text-sm font-semibold">Settings</h2>
			</div>
			<Separator />

			<ScrollArea className="min-h-0 flex-1">
				{/* A measure rather than the full width: this is a column of prose and
				    controls, and the section brings no aside to take the rest. */}
				<div className="mx-auto flex max-w-2xl flex-col gap-5 p-5">
					<EqualizerPanel />
					<DiscordPanel />
					{/* Last: the only panel that sets nothing, and the only one
					    ending in an action there is no way back from. */}
					<StoragePanel />
				</div>
			</ScrollArea>
		</div>
	);
}
