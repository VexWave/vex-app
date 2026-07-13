# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A desktop **music player** built with **Electrobun** (NOT Electron — do not use Electron APIs or patterns; see `llms.txt`). The user picks/drops audio files (played from blob URLs), sees cover/title/artist/duration, and plays them. On startup a blocking login screen asks for host/port of a backend server plus credentials (`POST /login` → token); once logged in, every added file is also gzip-compressed and uploaded (`POST /postTrack`), and the server library (`GET /tracks`) is queued as remote tracks that **stream progressively**: their `Track.src` (`src/mainview/player/types.ts`) is a loopback URL served by the bun-side `StreamProxy` (`src/bun/StreamProxy.ts`), which forwards to the backend's raw audio route (contract route `getTrackAudio` — Range/206 capable; fetched directly via `trackAudioPath` because the ts-rest client buffers response bodies) with the session token attached. Playback starts as soon as the audio element has buffered enough; seeking uses Range requests. The API contract (ts-rest + zod v4) lives at `contract/contract.ts`.

## Commands

- **bun only** — npm is not installed on this machine (the shadcn CLI fails for that reason; shadcn components are vendored by hand into `src/mainview/components/ui/`).
- `bun run dev:hmr` — development with Vite HMR (recommended); `bun run start` — vite build + run without HMR.
- `bunx tsc --noEmit` — type-check (no test framework or linter exists yet).
- The README is the stale upstream template — it references `bun run build`/`build:prod` scripts that don't exist; trust `package.json`.

## Architecture

Two contexts, per Electrobun's model:

- `src/bun/index.ts` — Bun main process. Creates the `BrowserWindow`; loads the Vite dev server (port 5173) when it's running on the dev channel, else `views://mainview/index.html`. Vite output (`dist/`) is copied into the bundle via the `build.copy` map in `electrobun.config.ts`.
- `src/mainview/` — React 18 webview UI. OOP player core in `src/mainview/player/` is framework-agnostic TypeScript: `AudioPlayer` (wraps one HTMLAudioElement, typed events) + `PlaybackQueue` (pure data: tracks/index/repeat) are owned by `PlayerController`, the facade the UI talks to. React consumes it via `useSyncExternalStore` through `src/mainview/hooks/usePlayer.ts` (module-level singleton). `LocalTrackLoader` turns picked `File`s into `Track`s (blob URLs + ID3 tags via `music-metadata`) and owns their disposal (`URL.revokeObjectURL`). Keep queue/transport logic in the core classes, not in components.
- **All server I/O runs bun-side** (`src/bun/ApiClient.ts`: ts-rest client, session token, `Bun.gzipSync`) — the webview never talks HTTP to the backend (no CORS, token never enters the webview). The webview reaches it via Electrobun RPC: schema in `src/shared/rpcSchema.ts` (type-only imports; safe for both contexts, but NOT under the `@/` alias — import it by relative path), webview singleton in `src/mainview/api/rpc.ts`. Both `defineRPC` calls set `maxRequestTime: 120_000` — Electrobun's default RPC timeout is 1 s, far too short for uploads. `src/mainview/api/SessionService.ts` + `UploadService.ts` + `LibraryService.ts` are `useSyncExternalStore` singletons like the player core (hooks: `useSession`, `useUploads`, `useLibrary`); UploadService uploads sequentially, LibraryService fetches the server library on login and removes all `origin: "remote"` tracks from the queue on logout (their stream URLs are session-scoped), and a 401 kicks the app back to the login screen — RPC results carry the status, while a 401 on the stream path (no RPC involved) is pushed by bun as the `sessionExpired` RPC message. `scripts/test-server.ts` is a throwaway backend (`test`/`test` on port 8790) for manual end-to-end testing.

## Conventions

- Tailwind **v3** + vendored shadcn (new-york style, CSS variables, dark theme via `class="dark"` on `<html>` in `index.html`). If using the shadcn CLI, pin `shadcn@2.3.0` — newer versions expect Tailwind v4.
- `@/` path alias → `src/mainview/` (defined in both `tsconfig.json` and `vite.config.ts`; keep them in sync).
- Tabs for indentation (template default throughout).
- `@types/three` is a required devDependency only because electrobun's own source imports `three`; without it `tsc` fails inside `node_modules/electrobun`.

## Gotchas

- **`win.bundleCEF: true` is intentional** — the system WebView2 path renders blurry on HiDPI displays because Electrobun's launcher doesn't declare DPI awareness (open bug: https://github.com/blackboardsh/electrobun/issues/324). Bundled CEF sets its own DPI awareness. Don't switch it back to `false` without checking that issue; side effect: CEF triggers a one-time Windows location-permission prompt (benign Chromium behavior).
- Electrobun's real docs are at https://framework.blackboard.sh/electrobun/ and https://github.com/blackboardsh/electrobun — the `blackboard.sh/electrobun/*` URLs in `llms.txt` redirect to a marketing SPA.
