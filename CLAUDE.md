# CLAUDE.md

This file guide Claude Code (claude.ai/code) when it work with code in this repo.

Layout, rules that hold for both halves of app, and conventions every file follow. What only one half need live beside that half, in `CLAUDE.md` that load when first file open under it:

| File | Covers |
| --- | --- |
| `src/bun/CLAUDE.md` | the bun main process: server I/O, the stream proxy, yt-dlp, Discord presence, Windows chrome |
| `src/mainview/CLAUDE.md` | the React webview: views, components, styling, persisted settings |
| `src/mainview/player/CLAUDE.md` | the playback core: queue, transport, shuffle |
| `src/mainview/api/CLAUDE.md` | the webview's services |

**Keep these files short.** They carry structure, rules that span files, and what code no can say by itself — never walkthrough how module work, never its history. Why a line take its shape belong in comment beside that line.

## What this is

A desktop **music player** built with **Electrobun** (NOT Electron — no use Electron APIs or patterns; see `llms.txt`).

All server-backed: blocking login screen ask for backend's address (an `http://` or `https://` URL) plus credentials, and every track in queue stream from that server. Local files get upload and re-enter queue through library refresh; YouTube/SoundCloud URLs get import through bundled yt-dlp, same tool also power Discover view's search. Tracks, artists and playlists get CRUD-managed against backend. API contract (ts-rest + zod v4) is `contract/contract.ts` — read it for routes.

## Commands

- **bun only** — npm and node not installed on this machine, this why shadcn CLI no can run; its components get vendored by hand into `src/mainview/components/ui/`.
- `bun run dev:hmr` — the one to develop with: Vite HMR on 5173 alongside app. `bun run start` run from bundled assets instead.
- `bun run release` — whole release procedure: pick next version, tag main's current commit and push it. Only pushed `v*` tag build stable; nothing else in CI do.
- `bun run build:installer:stable` / `build:installer:canary` — what CI run: channel's build plus `scripts/fuse-installer.ts`, which fold electrobun's Windows installer set into one self-contained exe in `installers/`. Both build UI first, and two channels' names differ, so they coexist.
- **`dev` and `build:stable` skip the Vite build**, unlike `start` and `build:canary` — they ship whatever `dist/` already hold, which be stale UI if webview change since.
- `bunx tsc --noEmit` — type-check (no test framework or linter exist yet). **`scripts/` is second project** (`bunx tsc --noEmit -p scripts`): root config's `DOM` lib collide with bun's own globals over `Response`/`BodyInit`.
- `bun run scripts/test-server.ts` — throwaway backend for manual end-to-end testing (`test`/`test` on port 8790).
- README be showcase page, document no commands; `package.json` be only reference.

## The two contexts

A **bun main process** (`src/bun/`) and a **React 18 webview** (`src/mainview/`), with `src/shared/` hold what both may import.

**All server I/O run bun-side** — webview never send HTTP to backend (this avoid CORS entirely) and never learn its address. Anything UI need from network arrive over RPC or through `StreamProxy` loopback URL.

### RPC boundary

Schema in `src/shared/rpcSchema.ts`, webview singleton in `src/mainview/api/rpc.ts`.

- `rpcSchema.ts` is **not** under `@/` alias — import it by relative path. Its type-only imports be what keep it safe for both contexts.
- Both `defineRPC` calls set `maxRequestTime: 120_000`; Electrobun's 1 s default be far too short for uploads.
- Work that outlive even that (binary installs, URL imports) return from its RPC right away and stream progress as pushed messages.
- A 401 send back to login screen. Stream path have no RPC to carry one, so bun push `sessionExpired` instead.
- **A 429 get waited out, never retried into.** `Retry-After` ride the failure as `RpcFailure.retryAfterSec`; nothing in app retry itself.
- `presenceChanged` be only thing pushed *to* bun rather than requested: nothing return and nothing wait on it, and dropped update get corrected by next one. **State that no can correct itself that way be a request** — this why presence switch be `setPresenceEnabled`, answered with connection it leave behind.

### Payload ceilings

- **`src/shared/limits.ts` mirror the contract's bounds rather than importing them** — importing `contract/contract.ts` webview-side would pull zod and `Buffer` into browser bundle and hand webview the address it be kept ignorant of. `ApiClient` check mirror against contract at startup and throw on disagreement.
- **A payload over ceiling get refused before it get encoded** (`UploadService.enqueue`, every image picker), not when server answer 413. The 413 branch survive for server holding tighter line than contract, and defer to that server's own message.

## Conventions

- **`src/` carry near no comments.** Reader be agent that can read code, so anything code already say be waste. Two things earn line: fact from outside repo (upstream bug, OS or browser behaviour, spec, where magic number come from), and trap where code look wrong or removable but no is. Nothing else. `src/mainview/components/ui/` be vendored, leave what upstream ship there.
- **Comment that earn its place get trimmed short as it go** — one line, two where it must. Present tense, about what be there. State reason direct rather than through what thing replaced, no longer do, tried first, or would do if written another way. History belong in commit messages. Same go for these files.
- `@/` path alias → `src/mainview/` (defined in both `tsconfig.json` and `vite.config.ts`; keep them in sync).
- Tabs for indentation.
- `@types/three` be required devDependency only because electrobun's own source import `three`; without it `tsc` fail inside `node_modules/electrobun`.

## Gotchas

- **`win.bundleCEF: true` be intentional** — system WebView2 path render blurry on HiDPI because Electrobun's launcher declare no DPI awareness (open bug: https://github.com/blackboardsh/electrobun/issues/324), and bundled CEF set its own. Same issue be what startup resize nudge in `src/bun/index.ts` work around. Side effect: one-time Windows location-permission prompt.
- Electrobun's real docs be https://framework.blackboard.sh/electrobun/ and https://github.com/blackboardsh/electrobun — the `blackboard.sh/electrobun/*` URLs in `llms.txt` redirect to marketing SPA.