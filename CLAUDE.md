# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It holds what is worth knowing *before* writing any code here: how the project is laid out, the conventions it follows, and the decisions that look wrong until you know the reason. What the code says plainly at a glance stays out, and so does its history.

## What this is

A desktop **music player** built with **Electrobun** (NOT Electron — do not use Electron APIs or patterns; see `llms.txt`).

The app is entirely server-backed: a blocking login screen asks for host/port of a backend plus credentials, and every track in the queue streams from that server. Local files the user picks/drops are uploaded, then re-enter the queue via a library refresh. Tracks can be imported from YouTube/SoundCloud URLs via a bundled yt-dlp. Tracks, artists and playlists are all CRUD-managed against the backend. The API contract (ts-rest + zod v4) lives at `contract/contract.ts` — read it for the routes.

## Commands

- **bun only** — npm and node are not installed on this machine (the shadcn CLI fails for that reason; shadcn components are vendored by hand into `src/mainview/components/ui/`).
- `bun run dev:hmr` — development with Vite HMR (recommended). It runs `hmr` (Vite on port 5173) and `start` concurrently.
- `bun run start` — `vite build` + `electrobun dev`, i.e. run from bundled assets without HMR. `bun run dev` is `electrobun dev --watch` alone (no Vite build), `bun run vite:build` is the webview bundle on its own.
- `bun run build:canary` / `bun run build:stable` — packaged app (`electrobun build --env=…`); canary runs the Vite build first, stable does not.
- `bunx tsc --noEmit` — type-check (no test framework or linter exists yet).
- `bun run scripts/test-server.ts` — throwaway backend for manual end-to-end testing (`test`/`test` on port 8790).
- The README is a showcase page for GitHub readers only — it documents no commands, so `package.json` is the sole reference here.

## Architecture

Two contexts, per Electrobun's model.

### `src/bun/` — Bun main process

| File | Role |
| --- | --- |
| `index.ts` | Creates the `BrowserWindow` and wires the RPC handlers. Loads the Vite dev server (port 5173) on the dev channel, else `views://mainview/index.html`. Vite output (`dist/`) is copied into the bundle via the `build.copy` map in `electrobun.config.ts`. |
| `ApiClient.ts` | ts-rest client + session token. The only place that talks HTTP to the backend. |
| `StreamProxy.ts` | Loopback HTTP server. Re-serves backend audio/artist-image routes to the webview with the token attached. |
| `TrackCache.ts` | Byte-bounded in-memory LRU of fully-downloaded tracks. |
| `BinaryManager.ts` | Downloads yt-dlp/ffmpeg/ffprobe/deno into a per-user bin dir. |
| `UrlImporter.ts` | Runs yt-dlp, one job at a time. |
| `WindowChrome.ts` | Win32 FFI (`bun:ffi`) for the dark title bar and the window/taskbar icon. Windows-only, best-effort. |

**All server I/O runs bun-side** — the webview never issues HTTP to the backend (avoids CORS entirely) and never learns the backend's address. Anything the UI needs from the network goes through RPC or a `StreamProxy` loopback URL.

### `src/mainview/` — React 18 webview UI

- `player/` — framework-agnostic OOP core: `AudioPlayer` (one HTMLAudioElement, typed events) + `PlaybackQueue` (pure data) owned by `PlayerController`, the facade the UI talks to. **Keep queue/transport logic in these classes, not in components.** The queue always mirrors one *collection* — the whole library, a single playlist, or a single artist's tracks — tagged by `PlayerController.queueContextId`; playing from a view replaces the queue with that view's collection (`playCollection` / `playOrToggleCollection`), and services push refreshed content into the queue only while they own the context (`syncCollection`). The library, playlist and artist views render from their services' state, not from the queue.
- `api/` — `Session`/`Library`/`Artist`/`Playlist`/`Upload`/`Import`/`Binary`/`TrackCache`/`Navigation` services. All are module-level singletons exposed to React via `useSyncExternalStore` (one hook each in `hooks/`), same pattern as the player core. Add new state here, not in component-local state.
- `AudioPlayer` also owns the Web Audio graph behind `PlayerController.analyser`, built on the first playback. `createMediaElementSource` captures an element's output permanently and accepts it only once, so anything wanting the spectrum reads that analyser instead of building its own — `useAudioGlow` drives `CoverBackdrop`'s glow from it.
- `NavigationService` holds the current view and the item opened in it, so any component can navigate (a track row jumps to one of its artists) and logging out can reset it — open ids belong to the session that issued them.
- `components/` — the three track lists share one `TrackRow`, each supplying its own row menu, and take their edit/delete/playlist actions from `useTrackActions`; the playlist and artist views share `CollectionCard` and `CollectionHeader`. A new list or collection view composes those.
- `lib/storage.ts` — **all** localStorage access goes through this typed registry; declare each persisted key there once rather than touching `localStorage` directly.
- `lib/cacheBuster.ts` — a stream-proxy URL is keyed by its resource's stable id, so replacing a cover or an avatar server-side leaves Chromium serving the cached bytes from an identical URL. Bump the key's version and append it to force the refetch.

### RPC boundary

Schema in `src/shared/rpcSchema.ts`, webview singleton in `src/mainview/api/rpc.ts`.

- `rpcSchema.ts` uses type-only imports so it is safe for both contexts, but it is **not** under the `@/` alias — import it by relative path.
- Both `defineRPC` calls set `maxRequestTime: 120_000`. Electrobun's default is 1 s, far too short for uploads.
- Long-running work (binary installs, URL imports) returns from its RPC immediately and streams progress as **pushed messages** (`binaryProgress`, `urlImportProgress`) — those downloads outlive even the 120 s timeout.
- A 401 returns to the login screen. RPC results carry the status; a 401 on the stream path has no RPC to ride, so bun pushes a `sessionExpired` message instead.

## Deliberate decisions

Don't "fix" these without reading the reasoning.

- **URL import captures exactly one artist** — the media's creator (`%(channel,uploader,artist,creator)s`). No multi-artist parsing: platforms pack co-credits into a single string with per-platform separators, and every attempt to split them was worse than just crediting the uploader. The dialog offers it as an opt-in suggestion, fuzzy-matched against existing artists (`lib/artistMatch.ts`).
- **Creator avatars are YouTube-only and best-effort.** SoundCloud exposes none through yt-dlp, and those imports intentionally carry no avatar rather than substituting something else. The lookup must hit the channel's `/about` page — a bare channel URL returns the first *video's* thumbnails instead.
- **Every yt-dlp call passes `--encoding UTF-8`.** Without it Windows encodes `--print` output in the console codepage and mangles accents.
- **Importer and yt-dlp updater mutually exclude each other** (in `index.ts`) — Windows can't overwrite a running exe.
- **Track audio is fetched with plain `fetch`, not the ts-rest client** — the client buffers response bodies, which defeats progressive streaming and Range requests.
- **Uploads only drop their pending placeholder once the following library refresh confirms the track landed**, so a failed refresh doesn't lose it.
- **A track id is a uuid, so the library's "newest first" order comes from the server's listing, not from the id.** `getTracks` is contractually oldest-first and `LibraryService.refresh` reverses it; sorting by id would order the list arbitrarily. Artists and playlists still have serial ids — only tracks changed.
- **An artist's tracks are joined by name.** The track listing carries its artists' *names*, not their ids (`TrackResponse.artists`), so that is the link `ArtistService.tracksOf` matches on — exactly, where imports match fuzzily (`lib/artistMatch.ts`). Two artists sharing a name therefore share a track list, and renaming or deleting an artist refetches the library, because every linked track embeds the name.
- **An artist's collection is re-derived from the library; a playlist's membership is its own.** `PlaylistService` syncs the queue when it refetches; `ArtistService` subscribes to `LibraryService` and syncs from there. A rename holds that sync until both have refetched — in between they disagree about the name, and the projection would come back empty.
- **Reordering a playlist is applied locally before the server confirms it** (`PlaylistService.applyOrder`) — the only membership edit that is. A drag has to land where it was dropped; every other edit has no position to spring back to. Because each reorder sends a full `trackIds` replacement and refetches, the refetch of an *earlier* reorder would undo a later one still in flight, so `refresh` shows the locally held order until the last one settles.
- **Losing the playing track from the collection it plays from stops playback** (`PlayerController.syncCollection`): the transport addresses the queue, so a track playing from outside it can no longer be paused or followed. It lands in the same state as a queue that ran off its end — nothing loaded, the rest still queued, play starts it over.
- **The now-playing ring rounds its width and gap to whole device pixels** (`--dpr`, published by `lib/devicePixelRatio.ts`) rather than stating them as a plain `2px`. Its box is snapped to the device grid independently of the artwork it wraps, so only an integer offset holds its shape on all four sides at fractional display scales. Reasoning in full above `.np-ring` in `index.css`.
- **The whole queue is cleared on logout** — every track streams from the session's server and stream URLs are session-scoped.
- **Log out is local only** (drops the stored token and the bun session); it does not revoke the token server-side.

## Conventions

- **Comments carry what the code can't**: what a piece of code does, and why it exists in the form it does. Code whose reason is plain from reading it needs none — a comment restating the line below it is noise.
- **Write comments in the present tense, about what is there.** They describe the code as it stands, not how it got there: no notes on what a thing replaced, what it no longer does, what was tried first, or what used to be wrong. History belongs in commit messages, where it is searchable and dated. The same goes for this file. (Contrast with a live constraint is fine and often the point — "rotating the element would rotate its shape with it" explains why the code can't take the obvious form.)
- Tailwind **v3** + vendored shadcn (new-york style, CSS variables, dark theme via `class="dark"` on `<html>` in `index.html`). If using the shadcn CLI, pin `shadcn@2.3.0` — newer versions expect Tailwind v4.
- `@/` path alias → `src/mainview/` (defined in both `tsconfig.json` and `vite.config.ts`; keep them in sync).
- Tabs for indentation (template default throughout).
- `@types/three` is a required devDependency only because electrobun's own source imports `three`; without it `tsc` fails inside `node_modules/electrobun`.

## Gotchas

- **`win.bundleCEF: true` is intentional** — the system WebView2 path renders blurry on HiDPI displays because Electrobun's launcher doesn't declare DPI awareness (open bug: https://github.com/blackboardsh/electrobun/issues/324). Bundled CEF sets its own DPI awareness. Don't switch it back to `false` without checking that issue; side effect: CEF triggers a one-time Windows location-permission prompt (benign Chromium behavior).
- **The Windows title bar and window icon are set by us, not Electrobun** (`src/bun/WindowChrome.ts`, called right after the window is created). Electrobun exposes no option for either: the caption would come up in the *system* theme (white) next to an app that is always dark, and its build step fails to embed `build.win.icon` into `bun.exe` (rcedit is resolved from a path baked into their CI), so the window would keep CEF's default icon. The icon is loaded at runtime from `Resources/app.ico` in the bundle — which the build *does* produce — and set with `WM_SETICON`, so it doesn't depend on the broken embedding step. All of it is best-effort: any failure logs a warning and leaves the stock chrome.
- Electrobun's real docs are at https://framework.blackboard.sh/electrobun/ and https://github.com/blackboardsh/electrobun — the `blackboard.sh/electrobun/*` URLs in `llms.txt` redirect to a marketing SPA.
