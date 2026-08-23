# One `/data` read — rebuilding the app's data fetching around it

## Context

`vex-backend` (`d3905f2`) replaced `getTracks`, `getArtists` and `getPlaylists` with a single
`getData` (`GET /data`) returning `{ tracks, artists, playlists }` from one Postgres snapshot,
and changed `TrackResponse.artists: string[]` to `artistIds: number[]`. `contract/contract.ts`
is already updated in this working tree, so `src/bun/ApiClient.ts:196,236,337` are live type
errors right now.

The app mirrors the old shape one-for-one: three RPCs, three services that each own a fetch
with its own sequence guard and 401 branch, and an artist↔track join done **by name**. Most of
the coordination code in `ArtistService` and `PlaylistService` exists only to paper over the
two weaknesses the new contract removes — that the two lists were fetched separately and could
disagree, and that the only link between them was a string. So this is not a call-site swap:
the pieces built around those weaknesses come out.

What the change buys:

- one read per refresh instead of three, and the server guarantees the three parts agree
- an id join, so duplicate-named artists stop sharing a track list
- `ArtistService.renamesInFlight`, `linksWithout`'s name→id resolution and its `"stale"` branch,
  `trackCountsByName`, and `PlaylistService`'s deleted-track detector all become unnecessary

## Target shape

```
libraryData ──(the one bun.getLibrary call)──▶ { tracks, artists, playlists, loading, error }
   │
   ├─▶ LibraryService   Track[] newest-first, artist-name join, trackById /
   │                    tracksByArtistId indices, track mutations, queue sync
   ├─▶ ArtistService    name-sorted artists, artist mutations, artist-as-collection
   └─▶ PlaylistService  dedupe + pendingOrders overlay, playlist mutations
```

`useLibrary` / `useArtists` / `usePlaylists` keep their signatures; the three services keep
their snapshots, because each layers real local state over the server's (the name sort, the
pending reorder, its own mutation error). What they lose is the fetching.

---

## 1. The wire — `src/shared/rpcSchema.ts`

- `RemoteTrack`: drop `artist?: string` and `artists: string[]`, add `artistIds: number[]`.
- Add `RemoteLibrary { tracks; artists; playlists }` and
  `GetLibraryResult = ({ ok: true } & RemoteLibrary) | RpcFailure`.
- Delete `ListTracksResult`, `ListArtistsResult`, `ListPlaylistsResult`.
- `PlayerRPC.bun.requests`: the three entries at `:445,446,450` become one
  `getLibrary: { params: undefined; response: GetLibraryResult }`. No message-side change —
  nothing pushed carries library data.

Carry into the new doc comments what the contract now guarantees and the old comments didn't
say: tracks are oldest-first, `artists` holds every artist the user owns *including ones no
track links to*, and a track's `artistIds` are ascending by artist id rather than in the order
they were submitted.

## 2. Bun — `src/bun/ApiClient.ts`, `src/bun/index.ts`

Replace `listTracks` (`:187`), `listArtists` (`:228`) and `listPlaylists` (`:329`) with one
`getLibrary`. Rather than four positional callbacks, declare the shape `StreamProxy` already
satisfies structurally:

```ts
/** How server ids become the loopback proxy URLs the webview loads. */
export interface ProxyUrls {
	urlForTrack(id: string): string;
	urlForTrackImage(id: string, version?: string): string;
	urlForArtistImage(id: number, version?: string): string;
	urlForPlaylistImage(id: number, version?: string): string;
}
```

so `index.ts:126-148` collapses to `getLibrary: () => api.getLibrary(streamProxy)`.

Preserve while merging, all of it currently load-bearing:

- the server's track order, untouched (`ApiClient.ts:184-186`)
- `coverUrl` / `imageUrl` staying `undefined` where the server sent none
- the `imageVersion(url)` → proxy-URL round-trip for all three image kinds
  (`:208,244-245,345-346`) — dropping it silently returns every cover to the uncached path

The three `expireSession()` calls and three fallback strings become one each. `getData` declares
no `413`, so the plain two-argument `failure(res, …)` is right.

**The name join does not move to bun.** Bun now holds both sides in one response and could
rebuild `artist`/`artists`, but that would re-duplicate every artist name once per track on the
wire — undoing exactly what the backend change did — and would leave the webview unable to
resolve an artist link to an id. `artistIds` goes across; the webview joins.

## 3. The one reader — new `src/mainview/api/LibraryData.ts`

The only module in the app that fetches the library. It owns what the three services each had a
copy of:

- the snapshot `LibraryDataState extends RemoteLibrary { loading; error }`, empty until first read
- `refresh(): Promise<boolean>` — sequence guard, `sessionService.markExpired` on 401,
  resolving `true` once a fresh payload is applied or superseded. **The boolean is contractual**:
  `UploadService` (`:308`) drops its pending placeholder only on a `true`.
- the `SessionService` lifecycle: refresh on `loggedIn`, bump the sequence and empty the payload
  on `loggedOut` (the three copies at `LibraryService.ts:50-67`, `ArtistService.ts:51-63`,
  `PlaylistService.ts:51-64` go)
- `subscribe` / `getSnapshot`, so the three services rebuild off it

Every existing `xService.refresh()` caller — `UploadService:308`, `AppHeader:38-41`,
`ArtistService.resolveOrCreate`, the mutation tails — calls `libraryData.refresh()` instead.
`AppHeader`'s comment about keeping two of the three stores in step goes with them.

## 4. New `src/mainview/api/mutate.ts`

`MutationResult` moves here from `LibraryService.ts:23` (its importers: `PlaylistService`,
`idListEdit`), joined by one helper that absorbs the ~12 identical copies of

```
try/catch → if (!result.ok) → if (status === 401) markExpired → return
```

across the three services (`LibraryService:203,243`, `ArtistService:209,275,373`,
`PlaylistService:246,272,437`). Each mutation then reads as the write it is, two or three lines.
It imports only `sessionService`, so no cycle with `rpc.ts`.

## 5. The three services

**`LibraryService`** — loses `refresh`, gains a rebuild that runs on every `libraryData` change:
`remoteById`, a `Map<number, string>` of artist names, `tracks` (reversed to newest-first, with
`toTrack` joining the names into `Track.artist`), plus two indices that replace per-call work:

- `trackById` / `tracksByIds(ids)` — `PlaylistService.tracksOf` (`:104-106`) rebuilds a whole
  `Map` on every call today, once per playlist per render of `PlaylistsView`
- `tracksByArtistId` — one pass instead of `ArtistService.tracksOf`'s O(n) filter per artist

Because tracks and artists arrive in one payload they cannot disagree, which is what makes the
derived `Track.artist` safe. Keeps `getRemote`, `trackIds`, `newestSince`, `play`, `playTrack`,
`editTrack`, `syncQueue`, `LIBRARY_QUEUE_CONTEXT`.

`removeTrack` (`:198-226`) stops patching locally and refreshes like every other mutation. The
local patch only made sense while each store held its own copy; now a stale shared payload would
leave artists and playlists disagreeing with the library, which is the thing being fixed. Its
queue drop is already covered by `syncQueue`.

**`ArtistService`** — snapshot becomes name-sorted artists derived from `libraryData`. Deleted
outright: `refresh`, `renamesInFlight` (`:46-49,188,302-308` — an id join has no window where the
two sides disagree, so `edit` is now one refresh whether or not the name changed),
`trackCountsByName` (`:113`, replaced by an id-keyed count off `tracksByArtistId`), and the
name→id map in `linksWithout` (`:344-363`), which becomes:

```ts
const artistIds = remote.artistIds.filter((id) => id !== artist.id);
```

— it can no longer be `"stale"`. `remove` (`:388-391`) drops its second refresh. `resolveOrCreate`
stays as it is: create still returns no id, so the artist is still found by name afterwards.

**`PlaylistService`** — snapshot becomes the deduped, `orderOf`-overlaid playlists derived from
`libraryData`. `refresh`'s fetch body goes; so does the deleted-track detector at `:74-85`,
which under a shared payload would both be redundant and re-trigger the fetch that woke it.
`pendingOrders`, `applyOrder`, `orderOf`, `membershipChain` / `enqueue` and
`chainMembershipEdit` all stay untouched — they are local state over server state, which is
exactly why this service keeps a snapshot of its own.

**Loading and error.** Both services mirror `libraryData.loading`, and their `error` becomes
their own mutation error falling back to the read's — so the existing `ErrorBanner` placements
(`App.tsx:119-123`, `ArtistsView:116`, `ArtistDetail:101`, `PlaylistsView:104`,
`PlaylistDetail:179`) keep working, and a mutation error is cleared by the next successful read
the way `update({ loading: true, error: null })` clears it today.

## 6. `idListEdit.ts`

Drop the `resync` parameter and call `libraryData.refresh()` inside `submitIdList`. Both callers
now resync the same single read, so leaving it a per-caller choice only invites a wrong one.
`staleError` stays — a playlist this list doesn't hold is still a real case.

## 7. Components — `artistNames: string[]` → `artistIds: number[]`

The prop threads unchanged in shape, so memoized rows keep their referentially stable array
(`remote?.artistIds` has the same identity guarantee `remote?.artists` had — see
`src/mainview/CLAUDE.md`'s memo rule):

- `TrackList.tsx:149-159`, `PlaylistDetail.tsx:214-215` — pass `artistIds`
- `LibraryTrackRow.tsx:27,43,71`, `PlaylistTrackRow.tsx:42,60,132` — prop rename
- `TrackMenuItems.tsx:41-53` (`TrackArtistItems`) — `artists.filter(a => artistIds.includes(a.id))`;
  its doc comment loses the caveat about a name with no artist behind it, which can't happen now
- `EditTrackDialog.tsx:62-75` — seed the picker straight from `getRemote(track.id)?.artistIds`;
  the name→id loop over `artistState.artists` goes (keep the deliberate dependency omission at `:80-83`)
- `ArtistsView.tsx:52-55,150` — id-keyed counts, `trackCounts.get(artist.id)`
- `AppHeader.tsx:36-41` — one `libraryData.refresh()`
- `TrackList.tsx` — add the first-load spinner the artists and playlists views already have
  (`loading && tracks.length === 0`), so an unloaded library stops rendering as an empty one

## 8. The test server and the preview fixture

- `scripts/test-server.ts` — replace the `/tracks`, `/artists` and `/playlists` handlers with one
  `/data`; `StoredTrack.artists: string[]` becomes `artistIds: number[]`, so `postTrack` and
  `editTrack` stop resolving ids into names. Emit each track's ids ascending, artists from the
  `artists` map itself (so orphans appear), playlist `trackIds` in stored order.
  **It registers routes by literal path string, so neither `bunx tsc --noEmit` nor
  `-p scripts` catches a missing `/data` — only running it does.**
- `.claude/skills/preview/harness/__preview-app.tsx:105-119,222-239` — the fixture library is
  keyed by artist name; build the id map once and give `REMOTES` `artistIds`, `TRACKS` the
  joined display string. Without this the `/preview` skill stops compiling.

## 9. Docs

- `src/mainview/api/CLAUDE.md` — the file that takes the damage. Line 11's `getTracks` becomes
  `getData`; **lines 18-19 are contradicted outright** and get rewritten around the id join and
  the single read; line 3 names `LibraryData` alongside `rpc.ts` and `idListEdit.ts` as a module
  that is not a service; line 7's "refetches" becomes the one shared read.
- `src/bun/CLAUDE.md` — the `?v=<hash>` bullet says "travels from the listing"; there is no
  per-entity listing any more. Wording only, the rule holds.
- Present tense, no "used to" — per the root `CLAUDE.md`.

---

## Behaviour changes worth knowing

- **A multi-artist credit line can reorder.** The server returns `artistIds` ascending by id,
  not in submission order, so `"B, A"` as picked comes back as `"A, B"`. Nothing client-side
  fixes this — the junction stores no position.
- **One read means one error.** A failed refresh now shows in all three views instead of one.
  That is honest: there is one fetch.
- **Deleting a track costs a round trip** it didn't before, in exchange for the three lists never
  disagreeing. The bulk read measured ~3× faster than the three it replaces, so a delete's
  refresh is still cheaper than today's library-plus-playlists pair.
- **Two artists sharing a name stop sharing a track list.**

## Verification

1. `bunx tsc --noEmit` **and** `bunx tsc --noEmit -p scripts` — both, they are separate projects.
2. `bun run scripts/test-server.ts`, then `bun run dev:hmr`; log in at `http://localhost:8790`
   with `test`/`test`. Confirm from the server's log that a login issues **one** `/data`.
3. Walk the paths the deleted machinery used to protect:
   - upload a file, and import a YouTube URL — the pending row clears only once the track lands
   - edit a track's artists; check the picker opened pre-selected
   - **rename an artist while that artist's page is open and playing** — the old
     `renamesInFlight` case; playback must not stop and the track list must not blink empty
   - delete an artist that has tracks; delete a track that sits in a playlist — the playlist
     drops it without a second fetch
   - unlink a track from an artist via the row menu
   - reorder a playlist by drag, twice quickly — rows stay where dropped
   - "Go to artist" from a row menu on a track with one artist and with several
   - log out and back in
4. `/preview` for the library, artists and playlists views, including the empty-library and
   first-load states.
