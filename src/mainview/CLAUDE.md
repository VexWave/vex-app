# src/mainview — the React 18 webview

UI only, no network reach itself: all server payload come over RPC or through `StreamProxy` loopback URL (root `CLAUDE.md`). State live in services under `api/` and in playback core under `player/`, each got own `CLAUDE.md`.

## Components

- Three track lists share one `TrackRow`, each got own row menu, get edit/delete/playlist actions from `useTrackActions`; playlist and artist views share `CollectionCard` and `CollectionHeader`; every view show emptiness through `EmptyState`. New list or collection view = compose those.
- **List's rows are `memo`ized.** `App` subscribe to player, so every view re-render on each `timeupdate` — many times per second during playback — unmemoized row rebuild whole list with it. Give rows referentially stable props: bound singleton methods, or callbacks from `useTrackActions`. React context is hole here — context update reach memoized consumer regardless.
- `App` render top-level views from exhaustive `Record<MainViewName, ComponentType>`, so view added to union without component here = compile error.
- **App split into *sections* — library, Discover, Settings — switched by `ViewSwitch` in app bar.** Which views a section holds = `NavigationService`'s job; how one looks = `components/Sections`. **Adding section touch no existing component** — compiler ask for entries it need.
- **Section's `Aside` decide if sidebar there**, never breakpoint: this fixed-size desktop window, on HiDPI displays CSS viewport can sit below Tailwind's `md`, where responsively-hidden sidebar unreachable. So **nothing whole app depend on may live in aside** — why logout sit in app bar.
- **Sidebar's badge counts keyed off its own `NAV_ITEMS`, not off `MainViewName`** — entry added there must bring own count, view in other section never need declare it has nothing to count.
- Settings panel = `Group` from `SettingsControls` (`EqualizerPanel`, `DiscordPanel`, `UninstallPanel`), holds `SettingRow`s where more to say than switch in header. Panel need not set anything: `UninstallPanel` holds one action, goes last, draws nothing where action not available. **`SettingsControls` decide how control looks, not where settings live**: `PlaybackEffects` take its `Toggle` into player bar's popover, draws own rows, cuz `Group` and `SettingRow` sized for settings column.
- **Discover result thumbnails load straight from platform's CDN**, not through `StreamProxy`, as CORS requests — `lib/coverFit` gotta read their pixels back. Webview-never-reach-backend rule about *backend*: thumbnail URL carry no token, reveal nothing about server.

## lib/

- `storage.ts` — **all** localStorage access go through this typed registry; declare each persisted key here once, don't touch `localStorage` direct.
- `devicePixelRatio.ts` — publish webview's device pixel ratio as `--dpr` on `<html>`, kept current through media query and `resize` listener (bun-side startup nudge why second one needed).
- `coverFit.ts` — decide if Discover thumbnail fill its square frame or contained in it, by reading loaded image's pixels.

## Styling

- Tailwind **v3** + vendored shadcn (new-york style, CSS variables, dark theme via `class="dark"` on `<html>`). If using shadcn CLI, pin `shadcn@2.3.0` — newer versions want Tailwind v4.
- Icons lucide, except platform brand marks in `components/Platforms.tsx`, vendored from Simple Icons (CC0). That file the one table of how searchable platform present itself, toggle's order derived from its keys so platform can't be added and stay invisible. Brand colours whole class names (`text-[#FF0000]`) cuz Tailwind only generate what it can read in source.