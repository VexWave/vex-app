import { useMemo, useState, type FormEvent } from "react";
import { AlertCircle, Compass, RotateCw, SearchX } from "lucide-react";
import { importService, parseImportUrl } from "@/api/ImportService";
import { DiscoverCard, DiscoverCardSkeleton } from "@/components/DiscoverCard";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { PLATFORM_ORDER, PLATFORMS } from "@/components/Platforms";
import { SearchInput } from "@/components/SearchInput";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useDiscover } from "@/hooks/useDiscover";
import { useImports } from "@/hooks/useImports";
import { cn, countLabel } from "@/lib/utils";
import type { ImportJob } from "@/api/ImportService";
import type { MediaSearchResult, SearchSource } from "../../shared/rpcSchema";

/**
 * The results grid, shared with the placeholders that stand in it while a search
 * runs — the two have to agree for the cards to land where the placeholders were.
 * A wider minimum than the playlist and artist grids: a sleeve holds its own
 * two-line title, which needs the room the label under a collection card takes
 * from the grid for free.
 */
const RESULT_GRID = "grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3 p-4";

/** A result together with everything about it the search itself doesn't know. */
interface ResultCard {
	result: MediaSearchResult;
	job: ImportJob | null;
	downloadable: boolean;
}

/**
 * Search YouTube/SoundCloud through the bundled yt-dlp and download a hit
 * straight into the library. Downloading is the same URL import a pasted link
 * starts, so a finished download opens the upload-review dialog with title, cover
 * and creator prefilled — and shows up in the library's pending rows as well as
 * on the card it was started from.
 *
 * A section of its own rather than a view in the sidebar: it holds hits from a
 * platform, not a collection you own. Its section declares no aside (see
 * `components/Sections`), so the results take the whole window — and the switch
 * that reached them is also the way back, which is why nothing here duplicates
 * it. It can be left mid-download without consequence: the job belongs to
 * `ImportService` and keeps reporting into the library's pending rows, and coming
 * back finds the same results, since `DiscoverService` outlives the view.
 */
export function DiscoverView() {
	const { discover, service } = useDiscover();
	const { imports } = useImports();
	// Seeded from the last search so leaving and coming back shows the query the
	// results on screen belong to.
	const [input, setInput] = useState(discover.query);

	// A hit and its download are joined by URL — a search result carries no id an
	// import knows — so each one's URL is normalized once here rather than per
	// render. `imports` is in the deps as the recompute trigger for `jobFor`.
	const cards = useMemo<ResultCard[]>(
		() =>
			discover.results.map((result) => {
				const url = parseImportUrl(result.url);
				return {
					result,
					job: url ? importService.jobFor(url) : null,
					downloadable: url !== null,
				};
			}),
		[discover.results, imports],
	);

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault();
		void service.search(input);
	};

	const sourceLabel = PLATFORMS[discover.source].label;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-3 px-4 py-2.5">
				{/* The same plain heading every view wears — the switch already names
				    this one in the app bar, glyph and all. */}
				<h2 className="shrink-0 text-sm font-semibold">Discover</h2>
				{discover.results.length > 0 && (
					<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
						{countLabel(discover.results.length, "result")}
					</span>
				)}
				<form className="ml-auto flex items-center gap-2" onSubmit={handleSubmit}>
					<SourceToggle value={discover.source} onChange={service.setSource} />
					{/* Inside the form, so Enter submits: each search spawns a yt-dlp
					    run, which is too expensive to fire off per keystroke. */}
					<SearchInput
						value={input}
						onChange={setInput}
						label={`Search ${sourceLabel}`}
						placeholder={`Search ${sourceLabel}`}
						className="w-72 min-w-0"
						autoFocus
					/>
					<Button
						type="submit"
						variant="secondary"
						size="sm"
						disabled={input.trim() === "" || discover.loading}
					>
						Search
					</Button>
				</form>
			</div>
			<Separator />

			<ErrorBanner error={discover.error} className="border-b" />

			{discover.loading ? (
				<ResultSkeletons />
			) : cards.length > 0 ? (
				<ResultGrid cards={cards} onDownload={service.download} />
			) : discover.error ? (
				// The banner above already carries the reason.
				<EmptyState
					icon={<AlertCircle className="h-8 w-8" />}
					title="That search didn't come back."
					action={
						<Button variant="secondary" size="sm" onClick={service.retry}>
							<RotateCw className="h-4 w-4" />
							Try again
						</Button>
					}
				/>
			) : discover.query ? (
				<EmptyState
					icon={<SearchX className="h-8 w-8" />}
					title={`No results for “${discover.query}”.`}
					hint={`Nothing on ${sourceLabel} matched — try different words, or the other platform.`}
				/>
			) : (
				<EmptyState
					framed
					icon={<Compass className="h-9 w-9" />}
					title={`Search ${sourceLabel} for something to listen to.`}
					hint="Downloads land in the review dialog first, so you can fix the title, cover and artist before they reach your library."
				/>
			)}
		</div>
	);
}

function ResultGrid({
	cards,
	onDownload,
}: {
	cards: readonly ResultCard[];
	onDownload: (result: MediaSearchResult) => void;
}) {
	return (
		<ScrollArea className="min-h-0 flex-1">
			<ul className={RESULT_GRID}>
				{cards.map(({ result, job, downloadable }) => (
					<li key={result.id}>
						<DiscoverCard
							result={result}
							job={job}
							downloadable={downloadable}
							onDownload={onDownload}
						/>
					</li>
				))}
			</ul>
		</ScrollArea>
	);
}

/**
 * The platform switch: two segments in one recessed track. Pressed buttons rather
 * than radios — arrow keys don't move between them, and claiming a radio group's
 * semantics would promise that they do.
 */
function SourceToggle({
	value,
	onChange,
}: {
	value: SearchSource;
	onChange: (source: SearchSource) => void;
}) {
	return (
		<div
			role="group"
			aria-label="Search platform"
			className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
		>
			{PLATFORM_ORDER.map((source) => {
				const { label, Icon, colorClass } = PLATFORMS[source];
				const active = source === value;
				return (
					<button
						key={source}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(source)}
						className={cn(
							"flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							active
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{/* The mark carries its brand colour only on the selected
						    segment: two saturated logos side by side would compete with
						    each other for the eye instead of showing which one is on. */}
						<Icon className={cn("h-3.5 w-3.5", active && colorClass)} />
						{label}
					</button>
				);
			})}
		</div>
	);
}

/**
 * The grid's own loading state rather than a spinner: the placeholders land in
 * the same grid the results will, so nothing jumps when they arrive.
 */
function ResultSkeletons() {
	return (
		<div className="min-h-0 flex-1 overflow-hidden">
			<ul aria-hidden="true" className={RESULT_GRID}>
				{Array.from({ length: 12 }, (_, i) => (
					<li key={i}>
						<DiscoverCardSkeleton index={i} />
					</li>
				))}
			</ul>
		</div>
	);
}
