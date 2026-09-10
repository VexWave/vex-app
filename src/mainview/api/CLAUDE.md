# src/mainview/api — the webview's services

`Session`/`Library`/`Artist`/`Playlist`/`Upload`/`Download`/`Import`/`Discover`/`Binary`/`Navigation`/`Presence`/`Uninstall`. All module-level singleton, show to React via `useSyncExternalStore` (one hook each in `hooks/`), same pattern as player core. **New state go here, not component-local state.**

Three module here not service: `rpc.ts`, Electroview singleton (`bun.…` for request, `onBunMessage` for pushed message, `notifyBun.…` for fire-and-forget), `LibraryData.ts` (below), `idListEdit.ts` (below).

**`LibraryData` only thing in app that read library.** One `getLibrary` call answer with tracks, artists, playlists from single server snapshot; `Library`/`Artist`/`Playlist` each derive snapshot from it, hold nothing but own stuff on top — name sort, reorder in flight, own last mutation error. Store clear on logout, re-read on login, keyed off `SessionService` status; nothing else got session lifecycle of own. **Mutation re-read rather than patch locally**, because server assign ids and drop what delete take with it — and because image URL name version of bytes behind it, that read also whole way replaced cover or avatar reach screen. One read mean one error and one spinner: failed one show in all three view, that honest.

## Track identity and ordering

- **Track id is uuid, so library "newest first" order come from server order, not from id.** `getData` contractually oldest-first, `LibraryService.apply` reverse it. Artists and playlists still got serial ids.
- **No write route return id it assigned**, so whatever client just made, it gotta find in next read: `LibraryService.newestSince` for track, `ArtistService.resolveOrCreate` by name for artist.
- **`Track` carry server id unchanged — not namespaced.** `LibraryService.toTrack` only place `Track` made, so no second kind of track id for prefix to tell apart.

## Collections

- **Collection played through own service, never component reach `playerController`** — queue context id it play under is one that service sync against on every later read.
- **Artist tracks joined by id**: track carry its artists' ids (`RemoteTrack.artistIds`), both side arrive in one read, so two artist sharing name keep separate track list, no window where two disagree. Names on track credit line joined in by `LibraryService`, which own id→tracks index artist view project through.
- **Artist collection re-derived from library; playlist membership own thing.** Both index `LibraryService` build once per read (`tracksOfArtist`, `tracksByIds`), not pass over library per artist or per playlist.

## Writes that replace a whole list of ids

- **Submit as intent, not as list** — `submitIdList` (`idListEdit.ts`), used by playlist membership edit and by unlink track from artist. Server validate such list as unit, and ids die behind client back (delete track drop it from every playlist), so hand over `build` that recompute list from current state is what let rejection answer by re-read rather than fail at user. Re-read on own — one read to re-run, so no caller choose. **New collection membership edit take same shape.**
- **Dialog write and playlist reorder stay off that path on purpose.** Dialog report failure inline for user to resubmit — silent re-send selection they wrote, minus whatever died under it, would change what they ask for. Reorder keep `applyOrder`, whose in-flight order identified by array identity that rebuilt array would break.
- **Reorder applied locally before server confirm it** (`PlaylistService.applyOrder`), only membership edit that so: drag gotta land where dropped. List keep showing locally held order till last reorder settle, or earlier one's read would undo later one still in flight.

## Uploads, imports, session

- **Upload drop pending placeholder only once following library read confirm track landed**, so failed read don't lose it.
- **Imported track start playing once its upload land, only upload that do** (`EnqueueOptions.playWhenReady`) — download user went and asked for is one they ask to hear.
- **At most one import job per URL**, what make URL enough to identify download: Discover card find own by matching `ImportJob.url` through same `parseImportUrl` normalization.
- Imports and Discover result **not** session-scoped — nothing about download touch backend till upload step, so both survive logout.
- **Whole queue cleared on logout** (`LibraryService` do it, on status change that empty `LibraryData`) — every stream URL session-scoped. **Log out local only**: it drop stored token and bun session without revoke anything server-side.
- **Server proxy persisted beside server address, only once proven**: by login succeeding, or by bun's probe for change made in Settings. **Setup screen's download proxy never stored**: ride only on that one install request.

## Navigation and presence

- `UninstallService` one service that fetch on component mount rather than off session change, and ask once: whether this copy installed one is fact about computer, so logout leave it alone. **yt-dlp update check asked from `YtDlpUpdateBanner` mount** too: banner exist only logged in, so check go through proxy login hand bun.
- `NavigationService` hold current view and item opened in it, so any component can navigate and logout can reset it. **Views grouped into sections**, and `SECTION_OF` where new view declare self; only structure live there, labels and glyphs being `components/Sections`'. **Section switched to rather than navigated to**, so each resume view last on.
- `PresenceService` odd one: only service whose state mostly *outbound*. Narrow player several-times-a-second notification down to change Discord would render, send `null` for pause (no paused presence — see `src/bun/CLAUDE.md`). **On/off switch app's, not bun's** — user preference, so persisted here and announced to bun process that keep no copy. That announcement request, not push: track update that go missing corrected by next one, switch that go missing not.