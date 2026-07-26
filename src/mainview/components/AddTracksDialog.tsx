import { useMemo, useState } from "react";
import { Check, Music, Plus, Search } from "lucide-react";
import { libraryService } from "@/api/LibraryService";
import { playlistService } from "@/api/PlaylistService";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useLibrary } from "@/hooks/useLibrary";
import type { RemotePlaylist } from "../../shared/rpcSchema";
import type { Track } from "@/player/types";

/**
 * Searchable library picker for editing the open playlist's membership. A
 * track can be in a playlist at most once, so each row is a toggle: clicking
 * adds the track, clicking again removes it. Every click applies immediately,
 * so the dialog can stay open while several tracks are added.
 */
export function AddTracksDialog({
	playlist,
	open,
	onOpenChange,
}: {
	playlist: RemotePlaylist | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { library } = useLibrary();
	const [query, setQuery] = useState("");

	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return library.tracks;
		return library.tracks.filter(
			(track) =>
				track.title.toLowerCase().includes(needle) ||
				track.artist?.toLowerCase().includes(needle),
		);
	}, [library.tracks, query]);

	const isIn = (track: Track): boolean => {
		const serverId = libraryService.getRemote(track.id)?.id;
		if (serverId === undefined || !playlist) return false;
		return playlist.trackIds.includes(serverId);
	};

	const toggle = (track: Track) => {
		const serverId = libraryService.getRemote(track.id)?.id;
		if (serverId === undefined || !playlist) return;
		void (isIn(track)
			? playlistService.removeTracks(playlist.id, [serverId])
			: playlistService.addTracks(playlist.id, [serverId]));
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) setQuery("");
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Add tracks</DialogTitle>
					<DialogDescription>
						Add library tracks to “{playlist?.name}”; click an added track to
						remove it again.
					</DialogDescription>
				</DialogHeader>
				<div className="relative">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search tracks"
						aria-label="Search tracks"
						className="h-8 pl-8 text-xs"
					/>
				</div>
				<ScrollArea className="h-72">
					{visible.length === 0 ? (
						<div className="flex h-full items-center justify-center py-10 text-sm text-muted-foreground">
							{library.tracks.length === 0
								? "The library is empty."
								: `No tracks match “${query}”.`}
						</div>
					) : (
						<ul className="flex flex-col gap-1 pr-3">
							{visible.map((track) => {
								const included = isIn(track);
								// Pending uploads have no server id yet, so they can't
								// be added — disabled beats a button that ignores the
								// click (same rule as the row menu's playlist entries).
								const unresolved =
									libraryService.getRemote(track.id)?.id === undefined;
								return (
									<li key={track.id}>
										<div className="flex w-full items-center gap-3 rounded-lg py-1.5 pl-2 pr-1">
											<div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-inset ring-border/60">
												{track.coverUrl ? (
													<img
														src={track.coverUrl}
														alt=""
														className="h-full w-full object-cover"
													/>
												) : (
													<Music className="absolute inset-0 m-auto h-4 w-4 text-muted-foreground" />
												)}
											</div>
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-medium">
													{track.title}
												</p>
												<p className="truncate text-xs text-muted-foreground">
													{track.artist ?? "Unknown artist"}
												</p>
											</div>
											<Button
												variant="ghost"
												size="icon"
												className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
												aria-label={
													included
														? `Remove ${track.title}`
														: `Add ${track.title}`
												}
												disabled={unresolved}
												onClick={() => toggle(track)}
											>
												{included ? (
													<Check className="h-4 w-4 text-primary" />
												) : (
													<Plus className="h-4 w-4" />
												)}
											</Button>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</ScrollArea>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
