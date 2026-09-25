# src/bun — the bun main process

Everything talk network, filesystem, OS. Webview no touch none of it except RPC boundary and loopback stream proxy — see root `CLAUDE.md` for both, and rule: all server I/O live here.

| File | Role |
| --- | --- |
| `index.ts` | Make `BrowserWindow`, wire RPC handlers. Also own mutual exclusion between yt-dlp spawners and updater, what an exit would cut off (`quitBusyReason`), and Windows startup resize nudge. |
| `ApiClient.ts` | ts-rest client + session token. Only place talk HTTP to backend. |
| `StreamProxy.ts` | Loopback HTTP server. Re-serve backend audio and images to webview with token attached, plus finished URL imports straight off disk. |
| `TrackDownloader.ts` | Write copy of track into folder user pick. Take bytes off `StreamProxy` own loopback URL, so download join same tee. |
| `TrackCache.ts` | Byte-bounded in-memory LRU of fully-downloaded tracks. |
| `BinaryManager.ts` | Download yt-dlp/ffmpeg/ffprobe/deno into per-user bin dir. |
| `UrlImporter.ts` | Run yt-dlp, one job at time. |
| `MediaSearch.ts` | yt-dlp searches of YouTube/SoundCloud for Discover view. |
| `searchRanking.ts` | Pure re-rank of one page of hits. No I/O, no yt-dlp. |
| `ytDlp.ts` | Plumbing both yt-dlp callers share: base args, child env, output reading, field parsing, failures. |
| `WindowChrome.ts` | Win32 FFI (`bun:ffi`) for dark title bar and window/taskbar icon. Windows-only, best-effort. |
| `Uninstaller.ts` | Remove VexWave from machine. Windows-only. |
| `AppUpdater.ts` | Check GitHub releases for newer VexWave, download installer, hand it to detached helper. |
| `download.ts` | GitHub latest-release lookup and throttled streaming download both updaters share. |
| `appRelease.ts` | Pure release parsing and version compare. No I/O, no electrobun. |
| `detachedHelper.ts` | What uninstaller and updater share: install roots, detached PowerShell helper, worker preamble that wait out app. |
| `DiscordPresence.ts` | Discord Rich Presence, speak straight to client local IPC socket (no library). Best-effort: no Discord running normal case, not fault. |

## Server I/O

- **Track audio fetch with plain `fetch`, not ts-rest client** — client buffer response bodies, defeat progressive streaming and Range requests.
- **Track bytes fetched once, wherever shareable.** Element stream it, `StreamProxy` tee into `TrackCache`; level scan (`mainview/player/programLevel`) take head off same tee through `/track/<id>/head`, fall back to own request only where no download to join. Second consumer of track bytes belong on that tee too.
- **Image `?v=<hash>` travel from `getData` read through to backend untouched.** Layer that drop it still serve right bytes, so nothing visibly break — just return every cover to route uncached path.
- **Proxy live in `ApiClient`, outside session**, since imports and searches outlive logout. Raw backend request built only by `fetchBackend`; every other request leaving machine, yt-dlp spawns included (through `childEnv`), take `api.proxy` too. Only exception setup-screen install: take one-time proxy off own request, bun keep no copy.

## Managed binaries and yt-dlp

Only Windows and macOS got bin dir, so `BinaryManager.isSupported` false everywhere else and both yt-dlp callers refuse up front rather than spawn path that no exist.

- **Importer and yt-dlp updater mutually exclude each other** — Windows can't overwrite running exe. `ytDlpBusyReason` (`index.ts`) one place know full set of spawners, new one belong there.
- **Every yt-dlp call pass `--encoding UTF-8`** (`YT_DLP_BASE_ARGS`, spread into each argument list so new caller can't forget it) — without it Windows mangle accents in `--print` output.
- **URL import capture exactly one artist**, the uploader. Platforms pack co-credits into single string with per-platform separators, every attempt split them worse.
- Creator avatars YouTube-only and best-effort, lookup must hit channel `/about` page — bare channel URL return first *video's* thumbnails instead.

## Discover search

- **Search answer from inside its RPC request** (`--flat-playlist`, so no entry resolved); downloads still can't. One search run at time — new query kill one still running, then fail as superseded.
- **Search exit code no decide success**: yt-dlp report unavailable entry or failed continuation page by exit code while hits it did resolve already on stdout.
- **`searchRanking.ts` never filter**, only reorder, so demoted hit still two rows away. Weights only comparable to each other — move one mean re-check rest against real pages.
- **YouTube Music not search source**: flat entries carry only id and title — nothing result card draw — filling those in cost one extraction per result.

## Discord Rich Presence

- **Discord given *backend's* cover URL, never app's own.** Activity images fetched by Discord media proxy from public internet, so webview loopback URL worthless here; backend on loopback, private range or local-only name dropped for logo asset, URL Discord can't fetch render as broken tile.
- **Rich Presence need application id**, hardcoded as `APPLICATION_ID` — not secret, since it ride in every payload, packaged build got no shell to read override from.
- **Switch belong to webview** (`@/api/PresenceService`): bun keep no copy and no default, connect only once told. Off drop socket and stop sweeps — closing socket also what clear card, so nothing sent on way out. `setEnabled` return resulting connection state as request answer; `onStatus` push only what Discord do on its own.
- **Live socket not accepted card.** Discord answer command under nonce it sent with, and can take connection while refuse activity — activity privacy off, payload it won't render. That reply only place difference appear.
- **Card exist only while track playing** — no paused state, no idle one, so `PresenceTrack` carry no play/pause flag: its presence *is* playing state.
- **Sends spaced by two timers**: 1 s debounce, and 5 s floor keep SET_ACTIVITY inside its 5-updates-per-20-seconds budget.

## Windows

- **Title bar and window icon set by us, not Electrobun** (`WindowChrome.ts`): caption would otherwise come up in *system* theme beside app always dark, and Electrobun build step fail embed `build.win.icon` (rcedit resolved from path baked into their CI). Icon loaded at runtime from `Resources/app.ico`, which build do produce. All best-effort.
- **App can't delete own install** (`Uninstaller.ts`), so uninstall hand script to detached helper and quit — Windows hold executing image open. **Quitting part of removal**: `index.ts` exit outright, not through `app.quit()`, once `quitBusyReason` find nothing running.
- **What it delete proved, not computed**: running executable must sit inside directory `version.json` name before anything removed. That also what make dev build refuse, and settings panel absent there.
- **App update also run through detached helper** (`AppUpdater.ts`): electrobun installer replace `<channel>\app` wholesale, silently skip locked files, and never start app it installed — so helper wait out every VexWave process, run installer, relaunch `app\bin\launcher.exe` itself. Download stop short of install: user click restart, `quitBusyReason` guard it like uninstall.
- **Window resized by 1px and back once webview up** (`index.ts`) — bundled CEF paint first frame before settle on monitor device scale factor, so at any scaling other than 100% layout come up zoomed and clipped until something force recompute. Timed off `dom-ready`, with 2 s fallback.