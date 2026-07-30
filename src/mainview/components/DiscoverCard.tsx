import { memo } from "react";
import { AlertCircle, Download, Loader2, Music } from "lucide-react";
import { importPercent, importStatusLabel } from "@/api/ImportService";
import { ArtistAvatar } from "@/components/ArtistAvatar";
import { cn, formatTime } from "@/lib/utils";
import type { ImportJob } from "@/api/ImportService";
import type { MediaSearchResult } from "../../shared/rpcSchema";

/**
 * One search hit in the Discover grid. The whole card is the download button —
 * there is exactly one thing to do with a result, and making the artwork, the
 * title and the creator one target means no part of the card looks clickable for
 * a different reason.
 *
 * With a download running the card takes over the pending row's job: the artwork
 * carries the spinner and the progress bar, and the creator line becomes the
 * job's status. A failed one stays failed and offers itself for a retry, which
 * replaces the failed attempt rather than stacking a second job on the same URL
 * (ImportService.start).
 *
 * Memoized for the same reason the track rows are: App re-renders on every player
 * timeupdate, and a grid of two dozen of these would be rebuilt several times a
 * second. `result` holds until the next search, `job` until the download's next
 * progress tick, and `onDownload` is the service's own bound method.
 */
export const DiscoverCard = memo(function DiscoverCard({
	result,
	job,
	downloadable,
	onDownload,
}: {
	result: MediaSearchResult;
	/** The import this card started, while it is still running or failed. */
	job: ImportJob | null;
	/** False for a hit no importer accepts — nothing to start, so it says so. */
	downloadable: boolean;
	onDownload: (result: MediaSearchResult) => void;
}) {
	const failed = job?.step === "error";
	const percent = job ? importPercent(job) : null;
	// Indexing a string would split an astral character in half.
	const initial = result.artist
		? [...result.artist.trim()][0]?.toUpperCase()
		: undefined;

	return (
		<button
			type="button"
			// A running download has nothing to re-start; an unimportable hit never
			// had anything to start.
			disabled={(job !== null && !failed) || !downloadable}
			onClick={() => onDownload(result)}
			aria-label={
				!downloadable
					? `${result.title} can't be imported`
					: job === null
						? `Download ${result.title}`
						: failed
							? `Retry downloading ${result.title}`
							: `Downloading ${result.title}`
			}
			// Phrasing content only inside a <button>: every box below is a span.
			className="group flex w-full flex-col gap-2 rounded-xl p-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
		>
			<span className="relative block aspect-video w-full overflow-hidden rounded-lg bg-muted shadow-sm ring-1 ring-inset ring-border/60">
				{result.thumbnailUrl ? (
					<>
						{/* The two platforms crop differently — YouTube hands out 16:9
						    video stills, SoundCloud square cover art — so the image is
						    contained rather than cropped, and a blurred, blown-up copy
						    of itself fills whatever the frame has left. On a 16:9
						    thumbnail the contained image covers the frame and this
						    never shows; a square cover gets pillarboxed in its own
						    colours instead of losing a third of its width. */}
						<img
							src={result.thumbnailUrl}
							alt=""
							aria-hidden="true"
							loading="lazy"
							className="absolute inset-0 h-full w-full scale-110 object-cover opacity-70 blur-xl saturate-150"
						/>
						<img
							src={result.thumbnailUrl}
							alt=""
							loading="lazy"
							className="relative h-full w-full object-contain"
						/>
					</>
				) : (
					<Music className="absolute inset-0 m-auto h-7 w-7 text-muted-foreground" />
				)}

				{/* The action layer: invited on hover, and held open for as long as
				    there is a job to report. */}
				<span
					className={cn(
						"absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[2px] transition-opacity duration-200",
						job !== null
							? "opacity-100"
							: "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
					)}
				>
					{failed ? (
						<AlertCircle className="h-6 w-6 text-destructive" />
					) : job !== null ? (
						<Loader2 className="h-6 w-6 animate-spin text-foreground" />
					) : downloadable ? (
						<span className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-md">
							<Download className="h-3.5 w-3.5" />
							Download
						</span>
					) : (
						<span className="text-xs font-medium text-muted-foreground">
							Can't be imported
						</span>
					)}
				</span>

				{/* Kept clear of the action layer's centre, and out of the way while
				    that layer is open. */}
				{result.durationSec !== undefined && job === null && (
					<span className="absolute bottom-1.5 right-1.5 rounded bg-background/85 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-foreground shadow-sm backdrop-blur-sm">
						{formatTime(result.durationSec)}
					</span>
				)}

				{percent !== null && (
					<span className="absolute inset-x-0 bottom-0 block h-1 bg-background/60">
						<span
							className="block h-full bg-primary transition-[width] duration-200"
							style={{ width: `${percent}%` }}
						/>
					</span>
				)}
			</span>

			<span className="block w-full min-w-0 px-0.5">
				{/* Two lines, at a fixed height so the creator lines of a row stay
				    level whether a title needs one line or two. */}
				<span className="line-clamp-2 min-h-10 text-sm font-medium leading-5">
					{result.title}
				</span>
				{job ? (
					<span
						className={cn(
							"mt-1 block truncate text-xs text-muted-foreground",
							failed && "text-destructive",
						)}
					>
						{importStatusLabel(job)}
					</span>
				) : (
					<span className="mt-1 flex min-w-0 items-center gap-1.5">
						{/* A search hit carries no creator image — resolving one costs a
						    second yt-dlp run per channel — so the initial stands in
						    until a finished download proposes the artist for real. */}
						<ArtistAvatar
							initial={initial}
							className="h-5 w-5 text-[10px] ring-1 ring-inset ring-border/60"
							iconClassName="h-3 w-3"
						/>
						<span className="truncate text-xs text-muted-foreground">
							{result.artist ?? "Unknown creator"}
						</span>
					</span>
				)}
			</span>
		</button>
	);
});
