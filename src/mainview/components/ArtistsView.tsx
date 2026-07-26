import { useEffect, useMemo, useState } from "react";
import { Loader2, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import { artistQueueContext, artistService } from "@/api/ArtistService";
import { openIdOf } from "@/api/NavigationService";
import { ArtistAvatar } from "@/components/ArtistAvatar";
import { ArtistDetail } from "@/components/ArtistDetail";
import { ArtistDialog } from "@/components/ArtistDialog";
import { CollectionCard } from "@/components/CollectionCard";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner } from "@/components/ErrorBanner";
import { NowPlayingRing } from "@/components/NowPlayingRing";
import { SearchInput } from "@/components/SearchInput";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useArtists } from "@/hooks/useArtists";
import { useLibrary } from "@/hooks/useLibrary";
import { useNavigation } from "@/hooks/useNavigation";
import { usePlayer } from "@/hooks/usePlayer";
import { trackCountLabel } from "@/lib/utils";
import type { RemoteArtist } from "../../shared/rpcSchema";

export function ArtistsView() {
	const { artists: state, service } = useArtists();
	const { view, service: navigation } = useNavigation();
	// The cards' play buttons mirror playback: a playing artist shows pause.
	const { state: playerState } = usePlayer();
	// An artist's tracks come from the library, so its counts follow it.
	const { library } = useLibrary();
	const [dialogOpen, setDialogOpen] = useState(false);
	// The artist being edited, or null when the dialog is in "create" mode.
	const [editing, setEditing] = useState<RemoteArtist | null>(null);
	const [pendingDelete, setPendingDelete] = useState<RemoteArtist | null>(null);
	const [query, setQuery] = useState("");

	const openCreate = () => {
		setEditing(null);
		setDialogOpen(true);
	};
	const openEdit = (artist: RemoteArtist) => {
		setEditing(artist);
		setDialogOpen(true);
	};

	// One pass over the library for the whole grid — a per-card count would be
	// re-derived on every player timeupdate. `library.tracks` is in the deps
	// purely as the recompute trigger for that read.
	const trackCounts = useMemo(
		() => artistService.trackCountsByName(),
		[library.tracks],
	);

	// Always render the *fresh* snapshot of the opened artist; if it was
	// deleted (here or server-side), fall back to the grid.
	const openId = openIdOf(view);
	const open =
		openId !== null
			? (state.artists.find((artist) => artist.id === openId) ?? null)
			: null;

	// The open id lives in the app's navigation state, so when the artist behind
	// it vanishes (deleted by another client, or the id outlived its session)
	// the navigation state must be told — otherwise the sidebar would keep
	// marking a detail view the grid has already replaced.
	useEffect(() => {
		if (openId !== null && open === null) navigation.openArtist(null);
	}, [openId, open, navigation]);

	const needle = query.trim().toLowerCase();
	const visible = needle
		? state.artists.filter((artist) =>
				artist.name.toLowerCase().includes(needle),
			)
		: state.artists;

	const firstLoad = state.loading && state.artists.length === 0;

	const dialogs = (
		<>
			<ArtistDialog
				artist={editing}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
			/>

			<ConfirmDialog
				open={pendingDelete !== null}
				onOpenChange={(next) => {
					if (!next) setPendingDelete(null);
				}}
				title="Delete artist?"
				description={`Removes “${pendingDelete?.name}” from the server. Its tracks are kept, but lose the credit.`}
				onConfirm={() => {
					if (pendingDelete) void service.remove(pendingDelete.id);
				}}
			/>
		</>
	);

	// The dialogs are rendered in both branches: the detail view opens the edit
	// one too, and mounting it only with the grid would unmount it there.
	if (open) {
		return (
			<>
				<ArtistDetail
					artist={open}
					onBack={() => navigation.openArtist(null)}
					onEdit={() => openEdit(open)}
				/>
				{dialogs}
			</>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-3 px-4 py-2.5">
				<h2 className="shrink-0 text-sm font-semibold">Artists</h2>
				{state.artists.length > 0 && (
					<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
						{state.artists.length}{" "}
						{state.artists.length === 1 ? "artist" : "artists"}
					</span>
				)}
				<div className="ml-auto flex items-center gap-2">
					{state.artists.length > 0 && (
						<SearchInput
							value={query}
							onChange={setQuery}
							label="Search artists"
							className="w-40 min-w-0"
						/>
					)}
					<Button variant="secondary" size="sm" onClick={openCreate}>
						<Plus className="h-4 w-4" />
						New artist
					</Button>
				</div>
			</div>
			<Separator />

			<ErrorBanner error={state.error} className="border-b" />

			{firstLoad ? (
				<div className="flex flex-1 items-center justify-center text-muted-foreground">
					<Loader2 className="h-6 w-6 animate-spin" />
				</div>
			) : state.artists.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
					<div className="flex h-20 w-20 items-center justify-center rounded-full border border-dashed">
						<Users className="h-9 w-9" />
					</div>
					<p className="text-sm">No artists yet — create one to get started.</p>
				</div>
			) : visible.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
					<Search className="h-8 w-8" />
					<p className="text-sm">No artists match “{query}”.</p>
				</div>
			) : (
				<ScrollArea className="min-h-0 flex-1">
					{/* A lower minimum than the playlist grid: artists accumulate one
					    per imported uploader, so once there is width for it this
					    list packs more per row. */}
					<ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 p-4">
						{visible.map((artist) => {
							// The queue already mirrors this artist → its button shows
							// pause (playOrToggle resumes instead of restarting), and
							// the avatar wears the sidebar's now-playing ring.
							const ownsQueue =
								playerState.queueContextId === artistQueueContext(artist.id);
							const playing = ownsQueue && playerState.isPlaying;
							const count = trackCounts.get(artist.name) ?? 0;
							return (
								<li key={artist.id}>
									<CollectionCard
										shape="round"
										artwork={
											<>
												<NowPlayingRing
													ownsQueue={ownsQueue}
													playing={playing}
													round
												/>
												<ArtistAvatar
													imageUrl={artist.imageUrl}
													className="aspect-square w-full ring-1 ring-inset ring-border/60"
													iconClassName="h-9 w-9"
												/>
											</>
										}
										name={artist.name}
										meta={trackCountLabel(count)}
										ownsQueue={ownsQueue}
										playing={playing}
										playLabel={
											playing ? `Pause ${artist.name}` : `Play ${artist.name}`
										}
										onOpen={() => navigation.openArtist(artist.id)}
										onPlay={
											count > 0
												? () => artistService.playOrToggle(artist)
												: undefined
										}
										actions={
											<>
												<Button
													variant="ghost"
													size="icon"
													className="h-7 w-7"
													aria-label={`Edit ${artist.name}`}
													onClick={(e) => {
														e.stopPropagation();
														openEdit(artist);
													}}
												>
													<Pencil className="h-4 w-4" />
												</Button>
												<Button
													variant="ghost"
													size="icon"
													className="h-7 w-7"
													aria-label={`Delete ${artist.name}`}
													onClick={(e) => {
														e.stopPropagation();
														setPendingDelete(artist);
													}}
												>
													<Trash2 className="h-4 w-4" />
												</Button>
											</>
										}
									/>
								</li>
							);
						})}
					</ul>
				</ScrollArea>
			)}

			{dialogs}
		</div>
	);
}
