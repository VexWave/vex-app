import { Users } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * An artist's round avatar, falling back to their initial and then to the shared
 * artists glyph when there is no image. Takes the URL rather than the artist so
 * it also fits the import suggestion's data URL and a search hit's creator, and
 * sizes itself from `className` — every place an artist appears (grid card,
 * detail header, pickers, Discover card) draws the same circle at its own size.
 *
 * A span, not a div: several of those places are inside a `<button>`, which
 * may only contain phrasing content.
 */
export function ArtistAvatar({
	imageUrl,
	initial,
	className,
	iconClassName,
}: {
	imageUrl?: string;
	/** Shown in place of the glyph when there is no image; takes its size from
	 * the circle's own font size. */
	initial?: string;
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
			) : initial ? (
				<span className="absolute inset-0 flex items-center justify-center font-semibold uppercase leading-none text-muted-foreground">
					{initial}
				</span>
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
