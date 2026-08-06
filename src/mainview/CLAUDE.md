# src/mainview — the React 18 webview

The UI, and nothing that reaches the network itself: every server payload arrives over RPC or through a `StreamProxy` loopback URL (root `CLAUDE.md`). State lives in the services under `api/` and in the playback core under `player/`, each of which has its own `CLAUDE.md`.

## Components

- The three track lists share one `TrackRow`, each supplying its own row menu, and take their edit/delete/playlist actions from `useTrackActions`; the playlist and artist views share `CollectionCard` and `CollectionHeader`; every view states its emptiness through `EmptyState`. A new list or collection view composes those.
- **A list's rows are `memo`ized.** `App` subscribes to the player, so every view re-renders on each `timeupdate` — several times a second during playback — and an unmemoized row rebuilds the whole list with it. Hand rows referentially stable props: bound singleton methods, or callbacks from `useTrackActions`. React context is the hole in this — a context update reaches a memoized consumer regardless.
- `App` renders top-level views from an exhaustive `Record<MainViewName, ComponentType>`, so a view added to the union without a component here is a compile error.
- **The app is divided into *sections* — the library, Discover and Settings — switched by `ViewSwitch` in the app bar.** Which views a section holds is `NavigationService`'s; how one looks is `components/Sections`. **Adding a section edits no existing component** — the compiler asks for the entries it needs.
- **A section's `Aside` decides whether the sidebar is there**, never a breakpoint: this is a fixed-size desktop window, and on HiDPI displays the CSS viewport can sit below Tailwind's `md`, where a responsively hidden sidebar would be unreachable. So **nothing the whole app depends on may live in an aside** — which is why logging out is in the app bar.
- **The sidebar's badge counts are keyed off its own `NAV_ITEMS`, not off `MainViewName`** — an entry added there has to bring its count with it, and a view in another section never has to declare that it has nothing to count.
- A settings panel is a `Group` from `SettingsControls` (`EqualizerPanel`, `DiscordPanel`), holding `SettingRow`s where it has more to say than the switch in its header.
- **Discover result thumbnails load straight from the platform's CDN**, not through the `StreamProxy`, and as CORS requests — `lib/coverFit` has to read their pixels back. The webview-never-reaches-the-backend rule is about the *backend*: a thumbnail URL carries no token and reveals nothing about the server.

## lib/

- `storage.ts` — **all** localStorage access goes through this typed registry; declare each persisted key there once rather than touching `localStorage` directly.
- `devicePixelRatio.ts` — publishes the webview's device pixel ratio as `--dpr` on `<html>`, kept current through a media query and a `resize` listener (the bun-side startup nudge is why the second is needed).
- `coverFit.ts` — decides whether a Discover thumbnail fills its square frame or is contained in it, by reading the loaded image's pixels.

## Styling

- Tailwind **v3** + vendored shadcn (new-york style, CSS variables, dark theme via `class="dark"` on `<html>`). If using the shadcn CLI, pin `shadcn@2.3.0` — newer versions expect Tailwind v4.
- Icons are lucide, except the platform brand marks in `components/Platforms.tsx`, vendored from Simple Icons (CC0). That file is the one table of how a searchable platform presents itself, with the toggle's order derived from its keys so a platform can't be added and still be invisible. Brand colours are whole class names (`text-[#FF0000]`) because Tailwind only generates what it can read in the source.
