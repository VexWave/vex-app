# src/bun — the bun main process

Everything that talks to the network, the filesystem or the OS. The webview reaches none of it except across the RPC boundary and through the loopback stream proxy — see the root `CLAUDE.md` for both, and for the rule that all server I/O lives here.

| File | Role |
| --- | --- |
| `index.ts` | Creates the `BrowserWindow` and wires the RPC handlers. Also owns the mutual exclusion between yt-dlp's spawners and its updater, and the Windows startup resize nudge. |
| `ApiClient.ts` | ts-rest client + session token. The only place that talks HTTP to the backend. |
| `StreamProxy.ts` | Loopback HTTP server. Re-serves backend track audio, track covers, artist avatars and playlist covers to the webview with the token attached, plus finished URL imports straight off disk. |
| `TrackCache.ts` | Byte-bounded in-memory LRU of fully-downloaded tracks. |
| `BinaryManager.ts` | Downloads yt-dlp/ffmpeg/ffprobe/deno into a per-user bin dir. |
| `UrlImporter.ts` | Runs yt-dlp, one job at a time. |
| `MediaSearch.ts` | yt-dlp searches of YouTube/SoundCloud for the Discover view. |
| `searchRanking.ts` | Pure re-ranking of one page of those hits. No I/O, no yt-dlp. |
| `ytDlp.ts` | Plumbing both yt-dlp callers share: the args every run passes, the child env, output reading, field parsing, failures. |
| `WindowChrome.ts` | Win32 FFI (`bun:ffi`) for the dark title bar and the window/taskbar icon. Windows-only, best-effort. |
| `DiscordPresence.ts` | Discord Rich Presence, spoken straight to the client's local IPC socket (no library). Best-effort: no Discord running is the normal case, not a fault. |

## Server I/O

- **Track audio is fetched with plain `fetch`, not the ts-rest client** — the client buffers response bodies, which defeats progressive streaming and Range requests.
- **An image's content version travels from the listing to the backend untouched.** The server puts a `?v=<hash>` on the `imageUrl`/`coverUrl` it hands out; `ApiClient` lifts it onto the `StreamProxy` URL, and the proxy puts it back on the backend path. A layer that drops it still serves the right bytes — which is why nothing visibly breaks — it just returns every cover to the route's uncached path, where the server re-reads the image out of Postgres because it can't know which bytes the caller meant.
- **The track cache is invisible to the webview** — nothing reports which tracks it holds, and no row is marked as cached. A hit is the same bytes arriving faster, so all a badge could tell the user is which tracks the LRU has not evicted yet, which is not a distinction they have any decision to make on.
- **A 413 defers to the server's own message.** The webview already refuses anything over the contract's ceilings before encoding it (see the root file), so a 413 that still arrives means this server holds a tighter line than the contract — quoting our own ceiling as *its* limit would be wrong at exactly the moment it appears.

## Managed binaries and yt-dlp

Only Windows and macOS have a bin dir, so `BinaryManager.isSupported` is false everywhere else and both yt-dlp callers refuse up front rather than spawning a path that doesn't exist.

- **Importer and yt-dlp updater mutually exclude each other** (in `index.ts`) — Windows can't overwrite a running exe. `ytDlpBusyReason` is the one place that knows the full set of spawners, so a new one belongs there.
- **Every yt-dlp call passes `--encoding UTF-8`** — `YT_DLP_BASE_ARGS` in `ytDlp.ts`, spread into each argument list so a new caller can't forget it. Without the flag Windows encodes `--print` output in the console codepage and mangles accents.
- **URL import captures exactly one artist** — the media's creator (`%(channel,uploader,artist,creator)s`). No multi-artist parsing: platforms pack co-credits into a single string with per-platform separators, and every attempt to split them was worse than just crediting the uploader. The webview's dialog offers it as an opt-in suggestion, fuzzy-matched against existing artists (`@/lib/artistMatch`).
- **Creator avatars are YouTube-only and best-effort.** SoundCloud exposes none through yt-dlp, and those imports intentionally carry no avatar rather than substituting something else. The lookup must hit the channel's `/about` page — a bare channel URL returns the first *video's* thumbnails instead.

## Discover search

- **A Discover search answers from inside its RPC request; downloads still can't.** `--flat-playlist` keeps a search to the platform's own search endpoint — no entry is resolved, so a whole page comes back in one round-trip of a few seconds. One search runs at a time: a new query kills the one still running, which then fails as superseded rather than resolving with results nobody asked for.
- **A search's exit code doesn't decide whether it succeeded.** yt-dlp reports one unavailable entry or a failed continuation page by exit code while the hits it did resolve are already on stdout, so `MediaSearch` returns whatever parsed and only reports the failure when nothing did.
- **All re-ranking is `searchRanking.ts`, and it never filters.** A pure function of one page plus the query — no I/O, no yt-dlp — so it can be checked against captured pages without running a search. Nothing is dropped: the ranking can be wrong, and a demoted hit is still two rows away. Weights are only comparable to each other, so moving one means re-checking the rest against real pages rather than reasoning about it.
- **YouTube Music is not a search source.** yt-dlp does reach `music.youtube.com/search?q=…#songs`, but its flat entries carry only an id and a title — no duration, creator or thumbnail, i.e. nothing a result card draws — and without `--playlist-items` it pages through hundreds of hits for ~20s. Filling those fields in would cost one extraction per result.

## Discord Rich Presence

- **Discord is given the *backend's* cover URL, never the app's own.** Activity images are rendered server-side: Discord hands the URL to its media proxy, which fetches it from the public internet, so the loopback stream-proxy URL the webview uses is worthless here. `DiscordPresence` builds the address off the backend's own cover route instead — the contract makes that route auth-free, so a publicly reachable backend needs nothing further. When the backend sits on loopback, a private range, or a name only a local resolver knows, the cover is dropped for the logo asset: a URL Discord can't fetch renders as a broken tile, which is worse than no cover at all.
- **Rich Presence needs a Discord application id**, hardcoded as `APPLICATION_ID`. Empty, the integration disables itself rather than connecting. It is checked in rather than configured because it isn't a secret — it rides in every presence payload — and a packaged build has no shell to read an override from. That application's *name* is what Discord prints as "Listening to …", and the art-asset key `LOGO_ASSET` (`vexwave`) resolves against its uploaded Rich Presence assets; a key that was never uploaded just renders no image, so it isn't required.
- **The presence exists only while a track plays** — no paused state, and no idle card either: with nothing playing there is no card at all. Audio that isn't sounding reads to someone else exactly like audio that was never started, so a card claiming the user is listening when they aren't is worse than none — and a card saying only that the app is open is worth nobody's attention. The webview sends `null` for a pause and the track again on resume, so `PresenceTrack` carries no play/pause flag at all: its presence *is* the playing state. `publish` takes the card down with a SET_ACTIVITY carrying no `activity`, and tracks whether one is up (`shown`) so an app that is only ever idle never sends anything at all.
- **Sends are spaced by two timers, not one.** A 1 s debounce lets a run of skips settle before anything goes out, and a 5 s floor under consecutive sends keeps SET_ACTIVITY inside its 5-updates-per-20-seconds budget however far apart the changes land. The webview has already narrowed the player's several-times-a-second notifications down to what Discord would render (`@/api/presenceBridge`).

## Windows

- **The title bar and window icon are set by us, not Electrobun** (`WindowChrome.ts`, called right after the window is created). Electrobun exposes no option for either: the caption would come up in the *system* theme (white) next to an app that is always dark, and its build step fails to embed `build.win.icon` into `bun.exe` (rcedit is resolved from a path baked into their CI), so the window would keep CEF's default icon. The icon is loaded at runtime from `Resources/app.ico` in the bundle — which the build *does* produce — and set with `WM_SETICON`, so it doesn't depend on the broken embedding step. All of it is best-effort: any failure logs a warning and leaves the stock chrome.
- **The window is resized by 1px and back once the webview is up** (`index.ts`). Bundled CEF paints its first frame before it has settled on the monitor's device scale factor, so at any scaling other than 100% the initial layout comes up zoomed with the window edges clipped until something forces a recompute. The nudge is timed off `dom-ready` rather than a fixed delay, because on a slow start a timer fires before CEF is rendering and the nudge does nothing; a 2 s fallback covers `dom-ready` never arriving. `@/lib/devicePixelRatio` listens for the resulting ratio change from the other side.
