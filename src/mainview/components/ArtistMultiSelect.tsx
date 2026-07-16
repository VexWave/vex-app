import { useState, type KeyboardEvent } from "react";
import { Check, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { RemoteArtist } from "../../shared/rpcSchema";

/** Above this many artists, a filter input is shown to keep the list usable. */
const FILTER_THRESHOLD = 8;

/**
 * A checklist of artists with avatar + name, selected by a `Set<number>` of
 * ids. Shared by the upload review dialog and the manage-artists dialog so
 * artist assignment looks identical wherever it happens. Above a threshold it
 * grows a filter input; the list scrolls within a height set via `className`.
 */
export function ArtistMultiSelect({
	artists,
	selected,
	onToggle,
	disabled,
	className,
}: {
	artists: RemoteArtist[];
	selected: ReadonlySet<number>;
	onToggle: (id: number) => void;
	disabled?: boolean;
	className?: string;
}) {
	const [filter, setFilter] = useState("");

	if (artists.length === 0) {
		return (
			<div className="flex flex-col items-center gap-2 py-6 text-center text-muted-foreground">
				<Users className="h-8 w-8" />
				<p className="text-sm">
					No artists yet — create some in the Artists tab first.
				</p>
			</div>
		);
	}

	const query = filter.trim().toLowerCase();
	const visible = query
		? artists.filter((a) => a.name.toLowerCase().includes(query))
		: artists;

	return (
		<div className="flex flex-col gap-2">
			{artists.length > FILTER_THRESHOLD && (
				<Input
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					disabled={disabled}
					placeholder="Filter artists…"
					// Swallow Enter so filtering never submits a surrounding form.
					onKeyDown={(e: KeyboardEvent) => {
						if (e.key === "Enter") e.preventDefault();
					}}
				/>
			)}
			<ScrollArea className={className}>
				{visible.length === 0 ? (
					<p className="px-2 py-6 text-center text-sm text-muted-foreground">
						No matches
					</p>
				) : (
					<ul className="flex flex-col gap-1 pr-3">
						{visible.map((artist) => {
							const checked = selected.has(artist.id);
							return (
								<li key={artist.id}>
									<button
										type="button"
										disabled={disabled}
										onClick={() => onToggle(artist.id)}
										className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
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
										<span className="relative h-8 w-8 shrink-0 overflow-hidden rounded-full bg-muted">
											{artist.imageUrl ? (
												<img
													src={artist.imageUrl}
													alt=""
													className="h-full w-full object-cover"
												/>
											) : (
												<Users className="absolute inset-0 m-auto h-4 w-4 text-muted-foreground" />
											)}
										</span>
										<span className="truncate">{artist.name}</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</ScrollArea>
		</div>
	);
}
