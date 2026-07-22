# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A desktop **music player** built with **Electrobun** (NOT Electron — do not use Electron APIs or patterns; see `llms.txt`).

The app is entirely server-backed: a blocking login screen asks for host/port of a backend plus credentials, and every track in the queue streams from that server. Local files the user picks/drops are gzip-uploaded, then re-enter the queue via a library refresh. Tracks can be imported from YouTube/SoundCloud URLs via a bundled yt-dlp. Tracks and artists are both CRUD-managed against the backend. The API contract (ts-rest + zod v4) lives at `contract/contract.ts` — read it for the routes.

## Commands

- **bun only** — npm is not installed on this machine (the shadcn CLI fails for that reason; shadcn components are vendored by hand into `src/mainview/components/ui/`).
- `bun run dev:hmr` — development with Vite HMR (recommended); `bun run start` — vite build + run without HMR.
- `bunx tsc --noEmit` — type-check (no test framework or linter exists yet).
- `scripts/test-server.ts` — throwaway backend for manual end-to-end testing (`test`/`test` on port 8790).
- The README is the stale upstream template — it references `bun run build`/`build:prod` scripts that don't exist; trust `package.json`.

## Architecture

Two contexts, per Electrobun's model.

### `src/bun/` — Bun main process

| File | Role |
| --- | --- |
| `index.ts` | Creates the `BrowserWindow` and wires the RPC handlers. Loads the Vite dev server (port 5173) on the dev channel, else `views://mainview/index.html`. Vite output (`dist/`) is copied into the bundle via the `build.copy` map in `electrobun.config.ts`. |
| `ApiClient.ts` | ts-rest client + session token + gzip. The only place that talks HTTP to the backend. |
| `StreamProxy.ts` | Loopback HTTP server. Re-serves backend audio/artist-image routes to the webview with the token attached. |
| `TrackCache.ts` | Byte-bounded in-memory LRU of fully-downloaded tracks. |
| `BinaryManager.ts` | Downloads yt-dlp/ffmpeg/ffprobe/deno into a per-user bin dir. |
| `UrlImporter.ts` | Runs yt-dlp, one job at a time. |

**All server I/O runs bun-side** — the webview never issues HTTP to the backend (avoids CORS entirely) and never learns the backend's address. Anything the UI needs from the network goes through RPC or a `StreamProxy` loopback URL.

### `src/mainview/` — React 18 webview UI

- `player/` — framework-agnostic OOP core: `AudioPlayer` (one HTMLAudioElement, typed events) + `PlaybackQueue` (pure data) owned by `PlayerController`, the facade the UI talks to. **Keep queue/transport logic in these classes, not in components.**
- `api/` — `Session`/`Library`/`Artist`/`Upload`/`Import`/`Binary`/`TrackCache` services. All are module-level singletons exposed to React via `useSyncExternalStore` (one hook each in `hooks/`), same pattern as the player core. Add new state here, not in component-local state.
- `lib/storage.ts` — **all** localStorage access goes through this typed registry; declare each persisted key there once rather than touching `localStorage` directly.

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
- **The whole queue is cleared on logout** — every track streams from the session's server and stream URLs are session-scoped.
- **Log out is local only** (drops the stored token and the bun session); it does not revoke the token server-side.

## Conventions

- Tailwind **v3** + vendored shadcn (new-york style, CSS variables, dark theme via `class="dark"` on `<html>` in `index.html`). If using the shadcn CLI, pin `shadcn@2.3.0` — newer versions expect Tailwind v4.
- `@/` path alias → `src/mainview/` (defined in both `tsconfig.json` and `vite.config.ts`; keep them in sync).
- Tabs for indentation (template default throughout).
- `@types/three` is a required devDependency only because electrobun's own source imports `three`; without it `tsc` fails inside `node_modules/electrobun`.

## Gotchas

- **`win.bundleCEF: true` is intentional** — the system WebView2 path renders blurry on HiDPI displays because Electrobun's launcher doesn't declare DPI awareness (open bug: https://github.com/blackboardsh/electrobun/issues/324). Bundled CEF sets its own DPI awareness. Don't switch it back to `false` without checking that issue; side effect: CEF triggers a one-time Windows location-permission prompt (benign Chromium behavior).
- Electrobun's real docs are at https://framework.blackboard.sh/electrobun/ and https://github.com/blackboardsh/electrobun — the `blackboard.sh/electrobun/*` URLs in `llms.txt` redirect to a marketing SPA.
