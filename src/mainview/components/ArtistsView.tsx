import { useState } from "react";
import { AlertCircle, Loader2, Plus, Trash2, Users } from "lucide-react";
import { CreateArtistDialog } from "@/components/CreateArtistDialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useArtists } from "@/hooks/useArtists";
import type { RemoteArtist } from "../../shared/rpcSchema";

function ArtistCard({
	artist,
	onDelete,
}: {
	artist: RemoteArtist;
	onDelete: () => void;
}) {
	return (
		<div className="group relative flex flex-col items-center gap-2 rounded-lg p-3 transition-colors hover:bg-accent">
			<div className="relative h-20 w-20 overflow-hidden rounded-full bg-muted">
				{artist.imageUrl ? (
					<img
						src={artist.imageUrl}
						alt=""
						className="h-full w-full object-cover"
					/>
				) : (
					<Users className="absolute inset-0 m-auto h-8 w-8 text-muted-foreground" />
				)}
			</div>
			<p className="w-full truncate text-center text-sm font-medium">
				{artist.name}
			</p>
			<Button
				variant="ghost"
				size="icon"
				className="absolute right-1 top-1 h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
				aria-label={`Delete ${artist.name}`}
				onClick={onDelete}
			>
				<Trash2 className="h-4 w-4" />
			</Button>
		</div>
	);
}

export function ArtistsView() {
	const { artists: state, service } = useArtists();
	const [createOpen, setCreateOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<RemoteArtist | null>(null);

	const firstLoad = state.loading && state.artists.length === 0;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between px-4 py-2.5">
				<h2 className="text-sm font-semibold">Artists</h2>
				<Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
					<Plus className="h-4 w-4" />
					New artist
				</Button>
			</div>
			<Separator />

			{state.error && (
				<div className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
					<AlertCircle className="h-4 w-4 shrink-0" />
					<span className="truncate">{state.error}</span>
				</div>
			)}

			{firstLoad ? (
				<div className="flex flex-1 items-center justify-center text-muted-foreground">
					<Loader2 className="h-6 w-6 animate-spin" />
				</div>
			) : state.artists.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
					<Users className="h-12 w-12" />
					<p className="text-sm">No artists yet — create one to get started.</p>
				</div>
			) : (
				<ScrollArea className="min-h-0 flex-1">
					<ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 p-4">
						{state.artists.map((artist) => (
							<li key={artist.id}>
								<ArtistCard
									artist={artist}
									onDelete={() => setPendingDelete(artist)}
								/>
							</li>
						))}
					</ul>
				</ScrollArea>
			)}

			<CreateArtistDialog open={createOpen} onOpenChange={setCreateOpen} />

			<Dialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) setPendingDelete(null);
				}}
			>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>Delete artist?</DialogTitle>
						<DialogDescription>
							Removes “{pendingDelete?.name}” from the server. Tracks are
							kept.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setPendingDelete(null)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								if (!pendingDelete) return;
								void service.remove(pendingDelete.id);
								setPendingDelete(null);
							}}
						>
							Delete
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
