import { memo, useState } from "react";
import { Ban, Download, Loader2, Music, RotateCw } from "lucide-react";
import { importPercent, importStatusLabel } from "@/api/ImportService";
import { Button } from "@/components/ui/button";
import { knownCoverFit, measureCoverFit } from "@/lib/coverFit";
import { cn, formatTime } from "@/lib/utils";
import type { SyntheticEvent } from "react";
import type { ImportJob } from "@/api/ImportService";
import type { CoverFit } from "@/lib/coverFit";
import type { MediaSearchResult } from "../../shared/rpcSchema";

/**
 * The sleeve itself: the one place its shape is stated, for the card and for the
 * placeholder that stands in its grid slot while a search runs. Its corner is
 * declared here alone — every layer inside takes it with `rounded-[inherit]`.
 */
const SLEEVE =
	"relative aspect-square w-full overflow-hidden rounded-2xl bg-muted";

/** The round slot in the sleeve's corner, whatever ends up sitting in it. */
const CORNER_SLOT =
	"absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full shadow-lg";

/**
 * One search hit in the Discover grid: a square sleeve carrying its title and
 * creator on the artwork itself. The sleeve is a picture, not a target — the
 * round button in its corner is the only thing that starts a download, and the
 * only part of the card that answers a click at all.
 *
 * Everything drawn on the sleeve is white over its own scrim rather than a theme
 * token: it sits on an arbitrary image, where `foreground` would be a coin toss.
 *
 * With a download running the card takes over the pending row's job: the corner
 * carries the spinner, the sleeve's foot carries the progress, and the creator
 * line becomes the job's status. A failed one stays failed and offers itself for
 * a retry, which replaces the failed attempt rather than stacking a second job
 * on the same URL (ImportService.start).
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
	const running = job !== null && !failed;
	const percent = job ? importPercent(job) : null;
	// There is something to start — a download, or a retry. A running one can't
	// be re-started, and an unimportable hit never had anything to start.
	const actionable = !running && downloadable;

	return (
		// `isolate` is load-bearing: the layers below are clipped to the sleeve's
		// rounded corners, and without a stacking context of their own each is
		// clipped and antialiased separately — the artwork's own corner pixels then
		// survive underneath the scrim's, showing as a pale fringe on the bottom
		// two corners of a light cover. Isolated, the group is composited first and
		// the corner is cut once, out of the finished picture.
		<div
			className={cn(
				SLEEVE,
				"group isolate shadow-md shadow-black/20 transition-shadow duration-200 hover:shadow-xl hover:shadow-black/30",
			)}
		>
			<SleeveArt url={result.thumbnailUrl} />

			{/* The pointer's answer, and the sleeve's own "busy": a plain darkening,
			    which leaves the artwork itself readable. */}
			<div
				className={cn(
					"absolute inset-0 rounded-[inherit] transition-colors duration-200",
					running ? "bg-black/40" : "bg-black/0",
					actionable && "group-hover:bg-black/30",
				)}
			/>

			{/* The bed the title and creator sit on, and the whole reason they can
			    live on the artwork at all. It reaches full black: 95% would leave a
			    light cover showing through the foot it is there to hide. */}
			<div className="absolute inset-x-0 bottom-0 h-2/3 rounded-b-[inherit] bg-gradient-to-t from-black via-black/55 to-transparent" />

			<div className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-white/10" />

			{result.durationSec !== undefined && (
				<span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white shadow-sm">
					{formatTime(result.durationSec)}
				</span>
			)}

			{/* Room kept on the right for the corner slot, so the title is laid out
			    the same whether a button is showing or not. */}
			<div className="absolute inset-x-0 bottom-0 min-w-0 p-3 pr-12">
				<p className="line-clamp-2 text-sm font-semibold leading-snug text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.5)]">
					{result.title}
				</p>
				<p
					className={cn(
						"mt-1 truncate text-xs text-white/70",
						// The destructive token is a deep red in the dark theme, which
						// disappears into the scrim it would be read on.
						failed && "text-red-400",
					)}
				>
					{/* A search hit carries no creator image — resolving one costs a
					    second yt-dlp run per channel — so the name stands alone until a
					    finished download proposes the artist for real. */}
					{job ? importStatusLabel(job) : (result.artist ?? "Unknown creator")}
				</p>
			</div>

			{downloadable ? (
				<Button
					size="icon"
					variant={failed ? "destructive" : "default"}
					disabled={running}
					onClick={() => onDownload(result)}
					aria-label={
						job === null
							? `Download ${result.title}`
							: failed
								? `Retry downloading ${result.title}`
								: `Downloading ${result.title}`
					}
					className={cn(
						CORNER_SLOT,
						// A white ring, because `ring` is a near-white the artwork can
						// swallow; and no dimming while disabled, since the running state
						// is drawn rather than greyed.
						"transition-opacity duration-200 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:opacity-100",
						running
							? "bg-black/70 text-white"
							: // Only a hit there is something to do with waits for the
								// pointer: the other states are the card's news, and news
								// doesn't wait to be asked for. Focus brings it out too,
								// since tabbing never raises a hover.
								!failed &&
								"opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
					)}
				>
					{failed ? (
						<RotateCw />
					) : running ? (
						<Loader2 className="animate-spin" />
					) : (
						<Download />
					)}
				</Button>
			) : (
				// Not a disabled button: a disabled control is skipped by the tab
				// order and shows no tooltip, which would leave the glyph as the only
				// account of itself anywhere on the card.
				<span
					role="img"
					title="Can't be imported"
					aria-label={`${result.title} can't be imported`}
					className={cn(CORNER_SLOT, "bg-black/70 text-white/60")}
				>
					<Ban className="h-4 w-4" />
				</span>
			)}

			{percent !== null && (
				// Rounds itself as well as inheriting: the fill is clipped by this
				// box, not by the sleeve's.
				<div className="absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-[inherit] bg-black/50">
					<div
						className="h-full bg-primary transition-[width] duration-200"
						style={{ width: `${percent}%` }}
					/>
				</div>
			)}
		</div>
	);
});

/**
 * A sleeve-shaped placeholder, so a search's results land in the layout they
 * will keep and nothing jumps when they arrive. Lives here, next to the card it
 * has to match, and takes its shape from the same constant.
 */
export function DiscoverCardSkeleton({ index }: { index: number }) {
	return (
		<div
			className={cn(SLEEVE, "flex animate-pulse flex-col justify-end gap-2 p-3")}
			// Staggered so the grid breathes as one wave instead of flashing in
			// lockstep.
			style={{ animationDelay: `${index * 80}ms` }}
		>
			<div className="h-3 w-4/5 rounded bg-foreground/10" />
			<div className="h-2.5 w-2/5 rounded bg-foreground/10" />
		</div>
	);
}

/**
 * The artwork filling the sleeve, in whichever of the two ways suits the image
 * (see `@/lib/coverFit`): a square cover — SoundCloud's, or one an art-track
 * upload put in the middle of a 16:9 frame — fills the sleeve, and a real still
 * is contained in it over a blurred, blown-up copy of itself rather than losing
 * a quarter of its width.
 *
 * The fit can only be measured once the image has decoded, so the first paint is
 * always the contained one; a URL measured earlier in the session skips that.
 */
function SleeveArt({ url }: { url: string | undefined }) {
	const [measured, setMeasured] = useState<CoverFit | null>(null);
	const [broken, setBroken] = useState(false);

	if (!url || broken) {
		return <Music className="absolute inset-0 m-auto h-9 w-9 text-muted-foreground" />;
	}

	const fit = measured ?? knownCoverFit(url) ?? "contain";

	const handleLoad = (e: SyntheticEvent<HTMLImageElement>) => {
		// Only a change is worth a render: most stills measure to the "contain"
		// already on screen, and committing that would rebuild the sleeve for
		// nothing.
		const next = measureCoverFit(url, e.currentTarget);
		if (next !== fit) setMeasured(next);
	};

	return (
		<>
			{fit === "contain" && (
				<img
					src={url}
					alt=""
					aria-hidden="true"
					loading="lazy"
					crossOrigin="anonymous"
					className="absolute inset-0 h-full w-full scale-110 object-cover opacity-80 blur-xl saturate-150"
				/>
			)}
			{/* Fetched as CORS so `coverFit` can read its pixels back, which both
			    platforms' CDNs allow. One that didn't would fail the load outright
			    rather than merely taint the canvas — hence the glyph above, the same
			    fallback a hit with no thumbnail at all gets. */}
			<img
				src={url}
				alt=""
				loading="lazy"
				crossOrigin="anonymous"
				onLoad={handleLoad}
				onError={() => setBroken(true)}
				className={cn(
					"absolute inset-0 h-full w-full rounded-[inherit]",
					fit === "cover" ? "object-cover" : "object-contain",
				)}
			/>
		</>
	);
}
