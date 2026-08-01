# src/mainview/api — the webview's services

`Session`/`Library`/`Artist`/`Playlist`/`Upload`/`Import`/`Discover`/`Binary`/`TrackCache`/`Navigation`. All are module-level singletons exposed to React via `useSyncExternalStore` (one hook each in `hooks/`), same pattern as the player core. **Add new state here, not in component-local state.**

Three modules here are not services:

- `rpc.ts` — the Electroview singleton. `bun.…` for requests, `onBunMessage` for pushed messages, `notifyBun.…` for fire-and-forget.
- `idListEdit.ts` — see below.
- `presenceBridge.ts` — no rendered state, no hook, just a player subscription that forwards to bun. It narrows the player's several-times-a-second notifications down to the changes Discord would actually render, and sends `null` for a pause (there is no paused presence — see `src/bun/CLAUDE.md`).

Every service that holds server data clears it on logout and refetches on login, keyed off `SessionService`'s status. A mutation refetches rather than patching locally, because the server assigns ids.

## Track identity and ordering

- **A track id is a uuid, so the library's "newest first" order comes from the server's listing, not from the id.** `getTracks` is contractually oldest-first and `LibraryService.refresh` reverses it; sorting by id would order the list arbitrarily. Artists and playlists still have serial ids — only tracks changed.
- **A `Track` carries the server's id unchanged — it is not namespaced.** `LibraryService.toTrack` is the only place a `Track` is made (the artist and playlist views project from the library's), so there is no second kind of track id for a prefix to tell it apart from; pending uploads are `UploadItem`s in their own list, never `Track`s. Prefixing it would mean every playlist membership check, every `deleteTrack`, and the Discord cover URL had to launder the id back through `LibraryService` first — a lookup that can miss, in front of a value that was never actually missing. `getRemote` stays for what a `Track` genuinely lacks: the linked artist names.

## Collections

- **An artist's tracks are joined by name.** The track listing carries its artists' *names*, not their ids (`TrackResponse.artists`), so that is the link `ArtistService.tracksOf` matches on — exactly, where imports match fuzzily (`@/lib/artistMatch`). Two artists sharing a name therefore share a track list, and renaming or deleting an artist refetches the library, because every linked track embeds the name.
- **An artist's collection is re-derived from the library; a playlist's membership is its own.** `PlaylistService` syncs the queue when it refetches; `ArtistService` subscribes to `LibraryService` and syncs from there. A rename holds that sync until both have refetched — in between they disagree about the name, and the projection would come back empty.

## Writes that replace a whole list of ids

- **A write that replaces a whole list of server ids is submitted as an intent, not as a list** — `submitIdList` (`idListEdit.ts`), used by playlist membership edits and by unlinking a track from an artist. The server validates such a list as a unit, so one id it no longer knows rejects the whole edit, and ids die behind the client's back: deleting a track drops it from every playlist, deleting an artist unlinks it from every track. Handing over a `build` that recomputes the list from current state is what lets a rejection be answered by refetching and rebuilding rather than by failing at the user; `PlaylistService` also watches the library for vanished ids, so the common case never reaches a rejected request. **A new collection's membership edits take the same shape.**
- **Dialog writes and playlist reordering stay off that path deliberately.** A dialog (`PlaylistDialog`'s seed tracks, `EditTrackDialog`'s artists) reports its failure inline for the user to resubmit — silently re-sending a selection they authored, minus whatever died under it, would change what they asked for. Reordering keeps `applyOrder`, whose in-flight order is identified by array identity that a rebuilt array would break.
- **Reordering a playlist is applied locally before the server confirms it** (`PlaylistService.applyOrder`) — the only membership edit that is. A drag has to land where it was dropped; every other edit has no position to spring back to. Because each reorder sends a full `trackIds` replacement and refetches, the refetch of an *earlier* reorder would undo a later one still in flight, so `refresh` shows the locally held order until the last one settles.

## Uploads and imports

- **Uploads only drop their pending placeholder once the following library refresh confirms the track landed**, so a failed refresh doesn't lose it.
- **At most one import job exists per URL** (`ImportService.start` drops a failed attempt at the same URL rather than keeping it beside the new one). That is what makes a URL enough to identify a download — a Discover hit shares no id with an import, so its card finds its own progress through `jobFor`.
- **A Discover card finds its running download by URL.** A search hit has no id the import knows about, so the card matches `ImportJob.url` against the same `parseImportUrl` normalization it started the download with — which also means a download started from the header's URL dialog lights up its card.
- Imports and Discover results are **not** session-scoped: nothing about a download touches the backend until the upload step, so both survive a logout.

## Session

- **The whole queue is cleared on logout** — every track streams from the session's server and stream URLs are session-scoped. `LibraryService` is what does it, on the same status change that clears its own list.
- **Log out is local only** (drops the stored token and the bun session); it does not revoke the token server-side.
- `NavigationService` holds the current view and the item opened in it, so any component can navigate (a track row jumps to one of its artists) and logging out can reset it — open ids belong to the session that issued them.
