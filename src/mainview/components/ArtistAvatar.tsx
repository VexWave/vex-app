import { Users } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * An artist's round avatar, falling back to the shared artists glyph when
 * there is no image. Takes the URL rather than the artist so it also fits the
 * import suggestion's data URL, and sizes itself from `className` — every
 * place an artist appears (grid card, detail header, pickers) draws the same
 * circle at its own size.
 *
 * A span, not a div: several of those places are inside a `<button>`, which
 * may only contain phrasing content.
 */
export function ArtistAvatar({
	imageUrl,
	className,
	iconClassName,
}: {
	imageUrl?: string;
	className?: string;
	iconClassName?: string;
}) {
	return (
		<span
			className={cn(
				"relative block shrink-0 overflow-hidden rounded-full bg-muted",
				className,
			)}
		>
			{imageUrl ? (
				<img src={imageUrl} alt="" className="h-full w-full object-cover" />
			) : (
				<Users
					className={cn(
						"absolute inset-0 m-auto text-muted-foreground",
						iconClassName ?? "h-8 w-8",
					)}
				/>
			)}
		</span>
	);
}
