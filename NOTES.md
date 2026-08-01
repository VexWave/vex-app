# Notes

Findings worth acting on later. Not design decisions — those belong in
`CLAUDE.md`; these are loose ends someone noticed and wrote down rather than
fixed on the spot.

## The track cache reaches the webview and stops there (2026-08-01)

`TrackCacheService` holds the set of track ids whose full audio bun already has
in memory, and `useTrackCache()` exposes it to React. **Nothing calls that hook.**
The badge it exists to draw — marking a row as instant to play — was never
rendered, so the whole chain is dormant.

Everything behind it is live and correct:

| Step | Where | State |
| --- | --- | --- |
| Byte-bounded LRU of downloaded tracks | `src/bun/TrackCache.ts` | working |
| Ids of what is fully cached | `StreamProxy.cachedTrackIds()` | working |
| Pushes membership changes | `src/bun/index.ts` → `trackCacheChanged` | working |
| Hydrates on login, clears on logout | `api/TrackCacheService.ts` | working |
| Exposes the set to React | `hooks/useTrackCache.ts` | working |
| Draws something with it | — | **missing** |

So this is a UI-only gap: the data is already arriving and already survives a
dev HMR reload (bun and its cache outlive the webview, which is what
`getCachedTracks` on login is for).

### Wiring it up

The set is keyed by **server track id**, which since the id refactor is exactly
`Track.id` — so a row can test its own membership directly:

```ts
const cached = useTrackCache();
// …per row:
cached.has(track.id)
```

Read the set once in the list component (`TrackList`, `PlaylistDetail`,
`ArtistDetail`) and pass a plain boolean down. The rows are `memo`ized against
per-`timeupdate` re-renders, so hand them the boolean, never the set — a fresh
`Set` identity each render would defeat the memo on every tick.

### The trap that used to be here

Before the id refactor, `Track.id` was `server-<uuid>` while the cache's ids
were bare uuids. `cached.has(track.id)` would have compiled, type-checked, and
silently matched **nothing** — a badge that simply never appeared, with no error
to explain it. That mismatch is gone now, but it is the reason this is worth a
note rather than a one-line ticket: the obvious implementation was quietly wrong
for reasons nothing in the types could show.
