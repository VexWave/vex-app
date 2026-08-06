import { Group, Toggle } from "@/components/SettingsControls";
import { usePresence } from "@/hooks/usePresence";
import { cn } from "@/lib/utils";

/**
 * The Discord Rich Presence: a switch, and a mark beside it saying whether
 * Discord is answering.
 *
 * The mark is there because the integration is silent by design — Discord not
 * running is the ordinary case — so without it the switch would have no visible
 * effect at all until a client happened to be up and a track happened to be
 * playing.
 */
export function DiscordPanel() {
	const { presence, service } = usePresence();

	return (
		<Group
			title="Discord Presence"
			description="Show what you're listening to on your Discord profile."
			action={(labelling) => (
				<div className="flex items-center gap-3">
					{/* Only while it is on: switched off, the switch has already said
					    everything there is to say. */}
					{presence.enabled && (
						<ConnectionMark connected={presence.connected} />
					)}
					<Toggle
						checked={presence.enabled}
						onChange={service.setEnabled}
						{...labelling}
					/>
				</div>
			)}
		/>
	);
}

/**
 * Whether Discord is reachable. Brightness, not hue: this palette is neutral
 * apart from the violet navigation accent and holds no colour that means
 * "good", so a green dot would be one invented for this line alone.
 */
function ConnectionMark({ connected }: { connected: boolean }) {
	return (
		<span
			className={cn(
				"flex items-center gap-1.5 text-xs",
				connected ? "text-foreground" : "text-muted-foreground",
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"h-2 w-2 rounded-full",
					connected ? "bg-foreground" : "bg-muted-foreground/40",
				)}
			/>
			{connected ? "Connected" : "Not connected"}
		</span>
	);
}
