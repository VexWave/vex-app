import { AlertCircle } from "lucide-react";

/**
 * Playlist-level errors (fetch, delete, and fire-and-forget membership
 * edits). Rendered in the grid *and* the detail view — membership edits
 * happen in the detail view, so their failures must be visible there.
 */
export function PlaylistsErrorBanner({ error }: { error: string | null }) {
	if (!error) return null;
	return (
		<div className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
			<AlertCircle className="h-4 w-4 shrink-0" />
			<span className="truncate">{error}</span>
		</div>
	);
}
