# src/mainview/player — the playback core

Framework-agnostic OOP core: `AudioPlayer` (one HTMLAudioElement, typed events) + `PlaybackQueue` (pure data, `ShuffleHistory` decide what shuffle play), owned by `PlayerController`, facade UI talk to. **Queue/transport logic stay in these classes, not components.** Nothing here know React or RPC; `hooks/usePlayer` own singleton, expose snapshot through `useSyncExternalStore`.

## The queue mirrors one collection

Queue always mirror one *collection* — whole library, one playlist, or one artist tracks — tagged by `PlayerController.queueContextId`. Play from view replace queue with that view collection (`playCollection` / `playOrToggleCollection`), services push fresh content into queue only while they own context (`syncCollection`). Library, playlist, artist views render from their services state, not from queue.

- **Lose playing track from collection it play from, playback stop** (`syncCollection`): transport address queue, so track playing from outside it no longer pause or follow.
- `syncCollection` also adopt collection when nothing queued yet (fresh login), preload first track **paused** so UI got something show.

## Shuffle

- **Shuffle pick one track at a time, two rule** (`ShuffleHistory.ts`): draw limited to tracks not played in round under way, and among those skip anything heard within last *half queue* of plays. Second rule not obvious — without it, round open easy on track that just closed last one, so one round tail run again at next round head while tracks that opened it wait nearly two rounds. Half queue is ceiling on that window: hold back more, too few candidate left for rounds to come out different order.
- **Shuffle remember ids, and remember own history.** Ids because `syncCollection` replace queue whole on every refetch of collection, renumber positions but not ids — refresh mid-round cost round nothing. Own history because Previous must walk back through what actually played, not through queue order.
- **Shuffle change where collection start, not which track a row play.** Collection-level play press pick random track (`playOrToggleCollection`); click row still play that row and shuffle onward from it.

## Web Audio

`AudioPlayer` own graph behind `PlayerController.analyser` — source → `Equalizer` → `Effects` (`Drive` → `Reverb`) → analyser → destination — build on first playback. `createMediaElementSource` capture element output permanent, accept only once, so anything want spectrum read that analyser instead of build own (`useAudioGlow` drive `CoverBackdrop` glow from it). **Build order in `ensureAnalyser` load-bearing**: element capture only once context confirm running, because suspended context swallow audio with no way hand back.

Every stage a `GraphStage` (`audioGraph.ts`) — one added to chain implement it or no compile — and hold its setting whether or not graph exist to apply it to, since panels open long before anything play. `attach` is what marry the two.

- **Equalizer is store of own** (`PlayerController.equalizer`, read through `hooks/useEqualizer`), not part of player state snapshot, persist by subscription rather than from setter.
- **`Effects` second store same kind** (`PlayerController.effects`, read through `hooks/useEffects`). It own speed plus one `Drive` and one `Reverb`, each own stage and file; hold no nodes itself. **Session-only** — every launch open on defaults.
- **Speed and volume both element property, so sit upstream of capture.** Speed cost nothing for it: equalizer, analyser, glow follow speed change without told. Volume why `Drive` exist — already spent by time graph see track, so stage fold it into slope of own saturation curve, re-apply after. It watch element itself for both thing it need: `volumechange` for that, `loadstart` for track its level belong to.
- **Volume cross loudness taper at `AudioPlayer`**: everything outside it — snapshot, slider, what persisted — position on control, while element and `Drive`, which read element, are in amplitude.
- **Nothing in `Drive` follow signal.** Its curve function of slider and volume alone; makeup a model of how program material spread, evaluate at track own level — read once off head of file by `programLevel`, held for whole track, because masters cut across several dB and what saturation cost depend on where. **Level read off signal as it play is what stay out**: it ride track own dynamics back at it, move level while nobody touch anything.
- **`programLevel` the one thing under `player/` that reach network** — the `/head` sibling of `StreamProxy` URL element play, decode off-graph, serve off element own download (how, is `bun/StreamProxy` job). Every failure return no answer, leave nominal level standing, so track that won't decode still play, still drive.
- Element is `crossOrigin = "anonymous"` (set before any `src`) so Web Audio expose its samples, which is what make `access-control-allow-origin: *` on every `StreamProxy` response mandatory rather than cosmetic.