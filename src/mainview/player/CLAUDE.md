# src/mainview/player — the playback core

A framework-agnostic OOP core: `AudioPlayer` (one HTMLAudioElement, typed events) + `PlaybackQueue` (pure data, with `ShuffleHistory` deciding what shuffle plays) owned by `PlayerController`, the facade the UI talks to. **Keep queue/transport logic in these classes, not in components.** Nothing here knows about React or RPC; `hooks/usePlayer` owns the singleton and exposes the snapshot through `useSyncExternalStore`.

## The queue mirrors one collection

The queue always mirrors one *collection* — the whole library, a single playlist, or a single artist's tracks — tagged by `PlayerController.queueContextId`. Playing from a view replaces the queue with that view's collection (`playCollection` / `playOrToggleCollection`), and services push refreshed content into the queue only while they own the context (`syncCollection`). The library, playlist and artist views render from their services' state, not from the queue.

- **Losing the playing track from the collection it plays from stops playback** (`syncCollection`): the transport addresses the queue, so a track playing from outside it can no longer be paused or followed. It lands in the same state as a queue that ran off its end — nothing loaded, the rest still queued, play starts it over.
- `syncCollection` also adopts a collection when nothing is queued yet (fresh login), preloading its first track **paused** so the UI has something to show.

## Shuffle

- **Shuffle picks one track at a time, under two rules** (`ShuffleHistory.ts`): the draw is limited to tracks that haven't played in the round under way, so none repeats while another still waits, and among those it passes over anything heard within the last *half queue* of plays. The second rule is the one that isn't obvious, and dropping it is the bug it was written for: a round drawn independently of the last one opens as readily on the track that just closed it, so the tail of one round runs again at the head of the next while the tracks that opened it wait out nearly two rounds. The round's memory resets at that boundary; how recently a track was heard does not. Half the queue is the ceiling on that window — hold back more and the remaining candidates are too few for the rounds to come out in different orders.
- **Shuffle remembers ids, and remembers its own history.** Ids because `syncCollection` replaces the queue wholesale on every refetch of its collection (an upload landing, an import finishing), renumbering positions but not ids — a refresh mid-round costs the round nothing. Its own history because Previous under shuffle has to walk back through what was actually played, not through the queue's order; walking back and forward again replays that history rather than extending it, so no track loses its turn.
- **Shuffle changes where a collection starts, not which track a row plays.** A collection-level play press picks a random track under shuffle (`playOrToggleCollection`) — it asks for the collection, not for its top — while clicking a row still plays that row and shuffles onwards from it.

## Web Audio

`AudioPlayer` also owns the Web Audio graph behind `PlayerController.analyser`, built on the first playback. `createMediaElementSource` captures an element's output permanently and accepts it only once, so anything wanting the spectrum reads that analyser instead of building its own — `useAudioGlow` drives `CoverBackdrop`'s glow from it. The build order in `ensureAnalyser` is load-bearing: the element is captured only once the context is confirmed running, because a suspended context swallows the audio with no way to hand it back.

The element is `crossOrigin = "anonymous"` (set before any `src`) so Web Audio will expose its samples — which is what makes the `access-control-allow-origin: *` on every `StreamProxy` response mandatory rather than cosmetic.
