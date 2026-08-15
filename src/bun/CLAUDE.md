# src/bun — the bun main process

Everything that talks to the network, the filesystem or the OS. The webview reaches none of it except across the RPC boundary and through the loopback stream proxy — see the root `CLAUDE.md` for both, and for the rule that all server I/O lives here.

| File | Role |
| --- | --- |
| `index.ts` | Creates the `BrowserWindow` and wires the RPC handlers. Also owns the mutual exclusion between yt-dlp's spawners and its updater, and the Windows startup resize nudge. |
| `ApiClient.ts` | ts-rest client + session token. The only place that talks HTTP to the backend. |
| `StreamProxy.ts` | Loopback HTTP server. Re-serves backend audio and images to the webview with the token attached, plus finished URL imports straight off disk. |
| `TrackCache.ts` | Byte-bounded in-memory LRU of fully-downloaded tracks. |
| `BinaryManager.ts` | Downloads yt-dlp/ffmpeg/ffprobe/deno into a per-user bin dir. |
| `UrlImporter.ts` | Runs yt-dlp, one job at a time. |
| `MediaSearch.ts` | yt-dlp searches of YouTube/SoundCloud for the Discover view. |
| `searchRanking.ts` | Pure re-ranking of one page of those hits. No I/O, no yt-dlp. |
| `ytDlp.ts` | Plumbing both yt-dlp callers share: base args, child env, output reading, field parsing, failures. |
| `WindowChrome.ts` | Win32 FFI (`bun:ffi`) for the dark title bar and the window/taskbar icon. Windows-only, best-effort. |
| `Uninstaller.ts` | Removes VexWave from the machine. Windows-only. |
| `DiscordPresence.ts` | Discord Rich Presence, spoken straight to the client's local IPC socket (no library). Best-effort: no Discord running is the normal case, not a fault. |

## Server I/O

- **Track audio is fetched with plain `fetch`, not the ts-rest client** — the client buffers response bodies, which defeats progressive streaming and Range requests.
- **A track's bytes are fetched once wherever they can be shared.** The element streams it and `StreamProxy` tees that into `TrackCache`; the level scan (`mainview/player/programLevel`) takes its head off the same tee through `/track/<id>/head`, falling back to a request of its own only where there is no download to join. A second consumer of a track's bytes belongs on that tee too.
- **An image's `?v=<hash>` travels from the listing through to the backend untouched.** A layer that drops it still serves the right bytes, so nothing visibly breaks — it just returns every cover to the route's uncached path.

## Managed binaries and yt-dlp

Only Windows and macOS have a bin dir, so `BinaryManager.isSupported` is false everywhere else and both yt-dlp callers refuse up front rather than spawning a path that doesn't exist.

- **Importer and yt-dlp updater mutually exclude each other** — Windows can't overwrite a running exe. `ytDlpBusyReason` (`index.ts`) is the one place that knows the full set of spawners, so a new one belongs there.
- **Every yt-dlp call passes `--encoding UTF-8`** (`YT_DLP_BASE_ARGS`, spread into each argument list so a new caller can't forget it) — without it Windows mangles accents in `--print` output.
- **A URL import captures exactly one artist**, the uploader. Platforms pack co-credits into a single string with per-platform separators, and every attempt to split them was worse.
- Creator avatars are YouTube-only and best-effort, and the lookup must hit the channel's `/about` page — a bare channel URL returns the first *video's* thumbnails instead.

## Discover search

- **A search answers from inside its RPC request** (`--flat-playlist`, so no entry is resolved); downloads still can't. One search runs at a time — a new query kills the one still running, which then fails as superseded.
- **A search's exit code doesn't decide whether it succeeded**: yt-dlp reports an unavailable entry or a failed continuation page by exit code while the hits it did resolve are already on stdout.
- **`searchRanking.ts` never filters**, only reorders, so a demoted hit is still two rows away. Its weights are only comparable to each other — moving one means re-checking the rest against real pages.
- **YouTube Music is not a search source**: its flat entries carry only an id and a title — nothing a result card draws — and filling those in would cost one extraction per result.

## Discord Rich Presence

- **Discord is given the *backend's* cover URL, never the app's own.** Activity images are fetched by Discord's media proxy from the public internet, so the webview's loopback URL is worthless here; a backend on loopback, a private range or a local-only name is dropped for the logo asset, a URL Discord can't fetch rendering as a broken tile.
- **Rich Presence needs an application id**, hardcoded as `APPLICATION_ID` — not a secret, since it rides in every payload, and a packaged build has no shell to read an override from.
- **The switch is the webview's** (`@/api/PresenceService`): bun keeps no copy and no default, and connects only once told. Off drops the socket and stops the sweeps — closing the socket is also what clears the card, so nothing is sent on the way out. `setEnabled` returns the resulting connection state as the request's answer; `onStatus` pushes only what Discord does on its own.
- **A live socket is not an accepted card.** Discord answers a command under the nonce it was sent with, and can take the connection while refusing the activity — activity privacy off, a payload it won't render. That reply is the only place the difference appears.
- **The card exists only while a track is playing** — no paused state and no idle one, so `PresenceTrack` carries no play/pause flag: its presence *is* the playing state.
- **Sends are spaced by two timers**: a 1 s debounce, and a 5 s floor keeping SET_ACTIVITY inside its 5-updates-per-20-seconds budget.

## Windows

- **The title bar and window icon are set by us, not Electrobun** (`WindowChrome.ts`): the caption would otherwise come up in the *system* theme beside an app that is always dark, and Electrobun's build step fails to embed `build.win.icon` (rcedit is resolved from a path baked into their CI). The icon is loaded at runtime from `Resources/app.ico`, which the build does produce. All best-effort.
- **The app can't delete its own install**, so the uninstall hands a script to a detached helper and quits — Windows holds an executing image open, and the tree being removed is the one every VexWave process runs out of. **Quitting is part of the removal, not what follows it**: `index.ts` exits outright rather than through `app.quit()`, whose shutdown wait has nothing left to do here. The same exclusions that guard the yt-dlp updater guard this, for the same reason. What that helper has to get right is `Uninstaller.ts`'s own doc.
- **What it deletes is proved, not computed**: `version.json` names the install directory, but a build reading someone else's copy of it would name a tree it has no business touching, so the running executable has to sit inside that directory before anything is removed. That is also what makes a dev build refuse, and so what leaves the settings panel absent there.
- **The window is resized by 1px and back once the webview is up** (`index.ts`) — bundled CEF paints its first frame before it has settled on the monitor's device scale factor, so at any scaling other than 100% the layout comes up zoomed and clipped until something forces a recompute. Timed off `dom-ready`, with a 2 s fallback.
