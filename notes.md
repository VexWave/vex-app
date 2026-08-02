# Notes

Findings worth keeping that aren't defects, and so have no bug to close and no
comment in the code to hang off.

## Preference writes are synchronous, and happen on every drag frame

*2026-08-03, noticed while building the equalizer.*

**What happens.** Dragging a control that persists its value writes to
localStorage on every pointer move — roughly 60 times a second — and
localStorage is synchronous, so each write blocks the webview's main thread.

Two paths do it:

| Path | Writes per move |
| --- | --- |
| `PlayerController.persistEqualizer` (`PlayerController.ts:331`), on every `Equalizer.commit` via the subscription at `PlayerController.ts:60` | 3 keys — `equalizer.enabled`, `equalizer.gains`, `equalizer.preamp` |
| `PlayerController.persistSettings` (`PlayerController.ts:319`), from `setVolume` and the repeat/shuffle toggles | 4 keys — `player.volume`, `player.muted`, `player.repeat`, `player.shuffle` |

So an equalizer fader drag costs ~180 writes/sec and a volume drag ~240. Each
writes every key in its group, not the one that changed.

**Why it is still like this.** The volume path predates the equalizer and
already behaved this way; the equalizer was made to match rather than to be
quietly better than the thing beside it. No jank has actually been observed —
the payloads are tiny (the whole EQ curve serialises to a few dozen characters)
and Chromium buffers writes rather than hitting disk each time.

**Why not just debounce it.** A trailing debounce drops the last write if the
app is killed inside the window, which is exactly when a user has just finished
setting something. Doing it properly means a flush on `pagehide` /
`visibilitychange` as well, and doing it to *both* paths — fixing only the
equalizer would leave two persistence behaviours in one class, which is worse
than the current one.

**If it ever needs fixing.** Put the debounce inside `StoredValue.set`
(`lib/storage.ts`) rather than at the call sites: every persisted preference
gets it at once, the call sites stay as they read now, and the flush has one
place to live. Writing only changed keys would fall out of the same change.
