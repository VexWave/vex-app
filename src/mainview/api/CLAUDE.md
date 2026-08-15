# src/mainview/api — the webview's services

`Session`/`Library`/`Artist`/`Playlist`/`Upload`/`Import`/`Discover`/`Binary`/`Navigation`/`Presence`/`Uninstall`. All are module-level singletons exposed to React via `useSyncExternalStore` (one hook each in `hooks/`), same pattern as the player core. **Add new state here, not in component-local state.**

Two modules here are not services: `rpc.ts`, the Electroview singleton (`bun.…` for requests, `onBunMessage` for pushed messages, `notifyBun.…` for fire-and-forget), and `idListEdit.ts` (below).

Every service that holds server data clears it on logout and refetches on login, keyed off `SessionService`'s status. **A mutation refetches rather than patching locally**, because the server assigns ids — and because an image URL names the version of the bytes behind it, that refetch is also the whole of how a replaced cover or avatar reaches the screen.

## Track identity and ordering

- **A track id is a uuid, so the library's "newest first" order comes from the server's listing, not from the id.** `getTracks` is contractually oldest-first and `LibraryService.refresh` reverses it. Artists and playlists still have serial ids.
- **No write route returns the id it assigned**, so whatever a client just created it has to find in the listing afterwards: `LibraryService.newestSince` for a track, `ArtistService.resolveOrCreate` by name for an artist.
- **A `Track` carries the server's id unchanged — it is not namespaced.** `LibraryService.toTrack` is the only place a `Track` is made, so there is no second kind of track id for a prefix to tell it apart from.

## Collections

- **A collection is played through its own service, never by a component reaching `playerController`** — the queue context id it plays under is the one that service's later refreshes sync against.
- **An artist's tracks are joined by name**: the track listing carries its artists' names, not their ids. Two artists sharing a name therefore share a track list, and renaming or deleting one refetches the library.
- **An artist's collection is re-derived from the library; a playlist's membership is its own.** A rename holds that sync until both have refetched — in between they disagree about the name, and the projection would come back empty.

## Writes that replace a whole list of ids

- **Submitted as an intent, not as a list** — `submitIdList` (`idListEdit.ts`), used by playlist membership edits and by unlinking a track from an artist. The server validates such a list as a unit, and ids die behind the client's back (deleting a track drops it from every playlist), so handing over a `build` that recomputes the list from current state is what lets a rejection be answered by refetching rather than by failing at the user. **A new collection's membership edits take the same shape.**
- **Dialog writes and playlist reordering stay off that path deliberately.** A dialog reports its failure inline for the user to resubmit — silently re-sending a selection they authored, minus whatever died under it, would change what they asked for. Reordering keeps `applyOrder`, whose in-flight order is identified by array identity that a rebuilt array would break.
- **Reordering is applied locally before the server confirms it** (`PlaylistService.applyOrder`), the only membership edit that is: a drag has to land where it was dropped. `refresh` shows the locally held order until the last reorder settles, or an earlier one's refetch would undo a later one still in flight.

## Uploads, imports, session

- **An upload drops its pending placeholder only once the following library refresh confirms the track landed**, so a failed refresh doesn't lose it.
- **An imported track starts playing once its upload lands, and it is the only upload that does** (`EnqueueOptions.playWhenReady`) — a download the user went and asked for is one they asked to hear.
- **At most one import job exists per URL**, which is what makes a URL enough to identify a download: a Discover card finds its own by matching `ImportJob.url` through the same `parseImportUrl` normalization.
- Imports and Discover results are **not** session-scoped — nothing about a download touches the backend until the upload step, so both survive a logout.
- **The whole queue is cleared on logout** (`LibraryService` does it, on the status change that clears its own list) — every stream URL is session-scoped. **Log out is local only**: it drops the stored token and the bun session without revoking anything server-side.

## Navigation and presence

- `UninstallService` is the one service that fetches on a component mount rather than off a session change, and asks once: whether this copy is an installed one is a fact about the computer, so a logout leaves it alone.
- `NavigationService` holds the current view and the item opened in it, so any component can navigate and logging out can reset it. **Views are grouped into sections**, and `SECTION_OF` is where a new view declares itself; only structure lives there, labels and glyphs being `components/Sections`'. **A section is switched to rather than navigated to**, so each resumes the view it was last on.
- `PresenceService` is the odd one: the only service whose state is mostly *outbound*. It narrows the player's several-times-a-second notifications down to the changes Discord would render and sends `null` for a pause (there is no paused presence — see `src/bun/CLAUDE.md`). **The on/off switch is the app's, not bun's** — a user preference, so it is persisted here and announced to a bun process that keeps no copy. That announcement is a request, not a push: a track update that goes missing is corrected by the next one, a switch that goes missing is not.
