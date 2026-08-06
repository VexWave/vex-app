# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It holds what is worth knowing *before* writing any code here: how the project is laid out, the rules that hold across both of its halves, and the conventions every file follows. What only one half needs lives beside that half, in a `CLAUDE.md` that loads with the first file opened under it:

| File | Covers |
| --- | --- |
| `src/bun/CLAUDE.md` | the bun main process: server I/O, the stream proxy, yt-dlp, Discord presence, Windows chrome |
| `src/mainview/CLAUDE.md` | the React webview: views, components, styling, persisted settings |
| `src/mainview/player/CLAUDE.md` | the playback core: queue, transport, shuffle |
| `src/mainview/api/CLAUDE.md` | the webview's services: session, library, artists, playlists, uploads, imports, discover |

What the code says plainly at a glance stays out of all of them, and so does its history.

## What this is

A desktop **music player** built with **Electrobun** (NOT Electron — do not use Electron APIs or patterns; see `llms.txt`).

The app is entirely server-backed: a blocking login screen asks for host/port of a backend plus credentials, and every track in the queue streams from that server. Local files the user picks/drops are uploaded, then re-enter the queue via a library refresh. Tracks can be imported from YouTube/SoundCloud URLs via a bundled yt-dlp, and the Discover view searches those platforms with the same yt-dlp to download a hit through that import. Tracks, artists and playlists are all CRUD-managed against the backend. The API contract (ts-rest + zod v4) lives at `contract/contract.ts` — read it for the routes.

## Commands

- **bun only** — npm and node are not installed on this machine (the shadcn CLI fails for that reason; shadcn components are vendored by hand into `src/mainview/components/ui/`).
- `bun run dev:hmr` — the one to develop with: Vite HMR on 5173 alongside the app. `bun run start` runs from bundled assets instead.
- **`dev` and `build:stable` skip the Vite build**, unlike `start` and `build:canary` — both ship whatever `dist/` already held, which is a stale UI if the webview changed since.
- `bunx tsc --noEmit` — type-check the app (no test framework or linter exists yet). **`scripts/` is a second project** (`bunx tsc --noEmit -p scripts`): it runs under bun alone, and the root config's `DOM` lib collides with bun's own globals over `Response`/`BodyInit`.
- `bun run scripts/test-server.ts` — throwaway backend for manual end-to-end testing (`test`/`test` on port 8790).
- The README is a showcase page for GitHub readers only — it documents no commands, so `package.json` is the sole reference here.

## The two contexts

Per Electrobun's model: a **bun main process** (`src/bun/`) and a **React 18 webview** (`src/mainview/`), with `src/shared/` holding the modules both may import.

**All server I/O runs bun-side** — the webview never issues HTTP to the backend (avoids CORS entirely) and never learns the backend's address. Anything the UI needs from the network goes through RPC or a `StreamProxy` loopback URL.

`src/bun/index.ts` creates the `BrowserWindow` and wires the RPC handlers. On the dev channel it loads the Vite dev server if one answers on 5173, else `views://mainview/index.html` — which is how the same channel serves both HMR and bundled assets. Vite output (`dist/`) is copied into the bundle via the `build.copy` map in `electrobun.config.ts`.

### RPC boundary

Schema in `src/shared/rpcSchema.ts`, webview singleton in `src/mainview/api/rpc.ts`.

- `rpcSchema.ts` uses type-only imports so it is safe for both contexts, but it is **not** under the `@/` alias — import it by relative path.
- Both `defineRPC` calls set `maxRequestTime: 120_000`. Electrobun's default is 1 s, far too short for uploads.
- Long-running work (binary installs, URL imports) returns from its RPC immediately and streams progress as **pushed messages** (`binaryProgress`, `urlImportProgress`) — those downloads outlive even the 120 s timeout.
- A 401 returns to the login screen. RPC results carry the status; a 401 on the stream path has no RPC to ride, so bun pushes a `sessionExpired` message instead.
- **A 429 is waited out, never retried into.** `Retry-After` rides the failure as `RpcFailure.retryAfterSec`; the login screen counts it down on a disabled button, since login is the one route with a throttle tight enough to hit by hand. Nothing retries itself — a background refresh that was told to back off shows its error instead of quietly continuing to knock.
- Presence is the one thing pushed *to* bun as a message rather than a request (`presenceChanged`) — nothing is returned and nothing waits on it, and a dropped update is corrected by the next one. **State that can't correct itself that way is a request**: the presence switch is `setPresenceEnabled`, answered with the connection it left behind.

### Payload ceilings

- **The contract's bounds are mirrored in `src/shared/limits.ts`, not imported from the contract.** Importing `contract/contract.ts` webview-side would pull zod and `Buffer` into the browser bundle and hand the webview an address it is otherwise kept ignorant of, so the numbers it checks against live in a module both contexts can read — as decoded bytes, since that is the unit a picked file is measured in. Only the two base64 caps are exported from the contract to check against; `ApiClient` does that at startup and throws on a disagreement, because a mirror that drifts high would wave through payloads the server rejects.
- **A payload over a ceiling is refused before it is encoded** (`UploadService.enqueue`, and every image picker), not when the server answers 413. Base64 costs a third more again and the whole string crosses the RPC bridge, so a file that cannot land would otherwise be paid for in full first. Artwork embedded in a tag is the one cover that is *dropped* rather than refused — nobody chose it, and failing a whole upload for it would be the wrong trade. The 413 branch in `ApiClient` survives for a server holding a tighter line than the contract, which is why it defers to that server's own message: our ceilings would be the wrong number to quote at exactly the moment it appears.

## Conventions

- **Comments carry what the code can't**: what a piece of code does, and why it exists in the form it does. Code whose reason is plain from reading it needs none — a comment restating the line below it is noise.
- **Write comments in the present tense, about what is there.** They describe the code as it stands, not how it got there: no notes on what a thing replaced, what it no longer does, what was tried first, or what used to be wrong. History belongs in commit messages, where it is searchable and dated. The same goes for these files. (Contrast with a live constraint is fine and often the point — "rotating the element would rotate its shape with it" explains why the code can't take the obvious form.)
- `@/` path alias → `src/mainview/` (defined in both `tsconfig.json` and `vite.config.ts`; keep them in sync).
- Tabs for indentation (template default throughout).
- `@types/three` is a required devDependency only because electrobun's own source imports `three`; without it `tsc` fails inside `node_modules/electrobun`.

## Gotchas

- **`win.bundleCEF: true` is intentional** — the system WebView2 path renders blurry on HiDPI displays because Electrobun's launcher doesn't declare DPI awareness (open bug: https://github.com/blackboardsh/electrobun/issues/324). Bundled CEF sets its own DPI awareness. Don't switch it back to `false` without checking that issue; side effect: CEF triggers a one-time Windows location-permission prompt (benign Chromium behavior). The same issue is what the startup resize nudge in `src/bun/index.ts` works around.
- Electrobun's real docs are at https://framework.blackboard.sh/electrobun/ and https://github.com/blackboardsh/electrobun — the `blackboard.sh/electrobun/*` URLs in `llms.txt` redirect to a marketing SPA.
