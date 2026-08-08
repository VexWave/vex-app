# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Layout, the rules that hold across both halves of the app, and the conventions every file follows. What only one half needs lives beside that half, in a `CLAUDE.md` that loads with the first file opened under it:

| File | Covers |
| --- | --- |
| `src/bun/CLAUDE.md` | the bun main process: server I/O, the stream proxy, yt-dlp, Discord presence, Windows chrome |
| `src/mainview/CLAUDE.md` | the React webview: views, components, styling, persisted settings |
| `src/mainview/player/CLAUDE.md` | the playback core: queue, transport, shuffle |
| `src/mainview/api/CLAUDE.md` | the webview's services |

**Keep these files short.** They carry structure, rules that span files, and what the code can't say on its own — never a walkthrough of how a module works, and never its history. Why a given line takes the form it does belongs in a comment beside that line.

## What this is

A desktop **music player** built with **Electrobun** (NOT Electron — do not use Electron APIs or patterns; see `llms.txt`).

Entirely server-backed: a blocking login screen asks for host/port of a backend plus credentials, and every track in the queue streams from that server. Local files are uploaded and re-enter the queue via a library refresh; YouTube/SoundCloud URLs are imported through a bundled yt-dlp, which also powers the Discover view's search. Tracks, artists and playlists are CRUD-managed against the backend. The API contract (ts-rest + zod v4) is `contract/contract.ts` — read it for the routes.

## Commands

- **bun only** — npm and node are not installed on this machine, which is why the shadcn CLI can't run; its components are vendored by hand into `src/mainview/components/ui/`.
- `bun run dev:hmr` — the one to develop with: Vite HMR on 5173 alongside the app. `bun run start` runs from bundled assets instead.
- `bun run release` — the whole release procedure: picks the next version, tags main's current commit and pushes it. Only a pushed `v*` tag builds stable; nothing else in CI does.
- `bun run build:installer:stable` / `build:installer:canary` — what CI runs: a channel's build plus `scripts/fuse-installer.ts`, which folds electrobun's Windows installer set into one self-contained exe in `installers/`. Both build the UI first, and the two channels' names differ, so they coexist.
- **`dev` and `build:stable` skip the Vite build**, unlike `start` and `build:canary` — they ship whatever `dist/` already held, which is a stale UI if the webview changed since.
- `bunx tsc --noEmit` — type-check (no test framework or linter exists yet). **`scripts/` is a second project** (`bunx tsc --noEmit -p scripts`): the root config's `DOM` lib collides with bun's own globals over `Response`/`BodyInit`.
- `bun run scripts/test-server.ts` — throwaway backend for manual end-to-end testing (`test`/`test` on port 8790).
- The README is a showcase page and documents no commands; `package.json` is the only reference.

## The two contexts

A **bun main process** (`src/bun/`) and a **React 18 webview** (`src/mainview/`), with `src/shared/` holding what both may import.

**All server I/O runs bun-side** — the webview never issues HTTP to the backend (avoiding CORS entirely) and never learns its address. Anything the UI needs from the network arrives over RPC or through a `StreamProxy` loopback URL.

### RPC boundary

Schema in `src/shared/rpcSchema.ts`, webview singleton in `src/mainview/api/rpc.ts`.

- `rpcSchema.ts` is **not** under the `@/` alias — import it by relative path. Its type-only imports are what keep it safe for both contexts.
- Both `defineRPC` calls set `maxRequestTime: 120_000`; Electrobun's 1 s default is far too short for uploads.
- Work that outlives even that (binary installs, URL imports) returns from its RPC immediately and streams progress as pushed messages.
- A 401 returns to the login screen. The stream path has no RPC to carry one, so bun pushes `sessionExpired` instead.
- **A 429 is waited out, never retried into.** `Retry-After` rides the failure as `RpcFailure.retryAfterSec`; nothing in the app retries itself.
- `presenceChanged` is the only thing pushed *to* bun rather than requested: nothing is returned and nothing waits on it, and a dropped update is corrected by the next one. **State that can't correct itself that way is a request** — which is why the presence switch is `setPresenceEnabled`, answered with the connection it left behind.

### Payload ceilings

- **`src/shared/limits.ts` mirrors the contract's bounds rather than importing them** — importing `contract/contract.ts` webview-side would pull zod and `Buffer` into the browser bundle and hand the webview the address it is kept ignorant of. `ApiClient` checks the mirror against the contract at startup and throws on a disagreement.
- **A payload over a ceiling is refused before it is encoded** (`UploadService.enqueue`, every image picker), not when the server answers 413. The 413 branch survives for a server holding a tighter line than the contract, and defers to that server's own message.

## Conventions

- **Comments carry what the code can't**: what a piece of code does, and why it exists in the form it does. A comment restating the line below it is noise.
- **Write comments in the present tense, about what is there** — not what a thing replaced, no longer does, or was tried first. History belongs in commit messages. The same goes for these files. (Contrast with a live constraint is fine and often the point.)
- `@/` path alias → `src/mainview/` (defined in both `tsconfig.json` and `vite.config.ts`; keep them in sync).
- Tabs for indentation.
- `@types/three` is a required devDependency only because electrobun's own source imports `three`; without it `tsc` fails inside `node_modules/electrobun`.

## Gotchas

- **`win.bundleCEF: true` is intentional** — the system WebView2 path renders blurry on HiDPI because Electrobun's launcher declares no DPI awareness (open bug: https://github.com/blackboardsh/electrobun/issues/324), and bundled CEF sets its own. The same issue is what the startup resize nudge in `src/bun/index.ts` works around. Side effect: a one-time Windows location-permission prompt.
- Electrobun's real docs are https://framework.blackboard.sh/electrobun/ and https://github.com/blackboardsh/electrobun — the `blackboard.sh/electrobun/*` URLs in `llms.txt` redirect to a marketing SPA.
