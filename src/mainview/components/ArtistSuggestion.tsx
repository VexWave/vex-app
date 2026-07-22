import { Check, UserCheck, UserPlus, Users } from "lucide-react";
import type { SuggestedArtist } from "@/api/UploadService";
import { useArtists } from "@/hooks/useArtists";
import { findMatchingArtist } from "@/lib/artistMatch";
import { cn } from "@/lib/utils";

/**
 * A single opt-in artist proposal: a compact checkbox row with avatar, name, and
 * a status chip. Matches the proposal against the library itself so it can show
 * the avatar the import fetched (or, for an artist already known, that artist's
 * own) and say whether confirming will link an existing artist or create one.
 */
export function ArtistSuggestion({
	suggestion,
	checked,
	onCheckedChange,
	disabled,
}: {
	suggestion: SuggestedArtist;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
}) {
	const { artists: artistState } = useArtists();
	const matched = findMatchingArtist(suggestion.name, artistState.artists);
	// The fetched bytes are already base64, so a data URL avoids a Blob and the
	// object-URL lifecycle that would come with it.
	const imageUrl = suggestion.imageBase64
		? `data:${suggestion.imageMime ?? "image/jpeg"};base64,${suggestion.imageBase64}`
		: matched?.imageUrl;

	return (
		<button
			type="button"
			disabled={disabled}
			aria-pressed={checked}
			title={
				matched && matched.name !== suggestion.name
					? `Matches “${matched.name}” in your library`
					: undefined
			}
			onClick={() => onCheckedChange(!checked)}
			className={cn(
				"flex w-full items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors disabled:opacity-50",
				checked
					? "border-primary/40 bg-primary/5"
					: "border-input hover:bg-accent",
			)}
		>
			<span
				className={cn(
					"flex h-4 w-4 shrink-0 items-center justify-center rounded border",
					checked
						? "border-primary bg-primary text-primary-foreground"
						: "border-input",
				)}
			>
				{checked && <Check className="h-3 w-3" />}
			</span>
			<span className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full bg-muted">
				{imageUrl ? (
					<img src={imageUrl} alt="" className="h-full w-full object-cover" />
				) : (
					<Users className="absolute inset-0 m-auto h-3.5 w-3.5 text-muted-foreground" />
				)}
			</span>
			<span className="min-w-0 flex-1 truncate">{suggestion.name}</span>
			<span
				className={cn(
					"inline-flex shrink-0 items-center gap-1 text-xs",
					matched ? "text-muted-foreground" : "text-primary",
				)}
			>
				{matched ? (
					<>
						<UserCheck className="h-3.5 w-3.5" />
						In library
					</>
				) : (
					<>
						<UserPlus className="h-3.5 w-3.5" />
						New
					</>
				)}
			</span>
		</button>
	);
}
