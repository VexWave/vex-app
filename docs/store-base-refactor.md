# Proposal: one `Store<T>` base for the three external stores

**Status: not done.** This is a design brief for a future change, written down so it
can be handed over whole. Nothing in the codebase depends on it.

## The problem

The app has three classes that are each a `useSyncExternalStore` external store, and
all three hand-roll the same bookkeeping:

| | `Equalizer.ts` | `Effects.ts` | `PlayerController.ts` |
| --- | --- | --- | --- |
| `private subscribers = new Set<() => void>()` | :59 | :99 | :19 |
| `private snapshot` | :63 | :103 | :21 |
| `subscribe = (onChange) => {…}` | :76 | :122 | :67 |
| `getSnapshot = () => this.snapshot` | :81 | :127 | :72 |
| `private buildSnapshot()` | :228 | :291 | :362 |
| notify all subscribers | in `commit()` :200 | in `commit()` :261 | in `refresh()` :380 |

(Line numbers are from the commit that added this file; treat them as a map, not a
contract.)

`subscribers`, `subscribe` and `getSnapshot` are **byte-identical** in all three,
banner comment included. The notify step differs only in name and in whether an
`apply()` runs first.

This was looked at once before and deferred, correctly: a base extracted for only
`Equalizer` and `Effects` deletes about twelve lines and buys a generic class, two
abstract methods and a file — a wash. **The reason to revisit is that there are three
of them, not two.** At three it is a real deletion, and a base that covered only the
two effect stores would leave the third looking like an anomaly it isn't.

## The design

A new `src/mainview/player/Store.ts`:

```ts
export abstract class Store<T> {
	private subscribers = new Set<() => void>();
	private snapshot: T | null = null;

	subscribe = (onChange: () => void): (() => void) => {
		this.subscribers.add(onChange);
		return () => this.subscribers.delete(onChange);
	};

	getSnapshot = (): T => (this.snapshot ??= this.buildSnapshot());

	/** Drop the built snapshot and tell everyone there is a new one to read. */
	protected emit(): void {
		this.snapshot = null;
		this.subscribers.forEach((notify) => notify());
	}

	protected abstract buildSnapshot(): T;
}
```

Then:

- `Equalizer extends Store<EqualizerState>`, `Effects extends Store<EffectsState>`,
  `PlayerController extends Store<PlayerState>`.
- Both effect stores' `commit()` becomes `this.apply(); this.emit();`.
- `PlayerController.refresh()` becomes `this.emit()`, and the
  `this.snapshot = this.buildSnapshot()` line in its constructor goes away entirely.
- `buildSnapshot` changes from `private` to `protected` in all three.
- No derived class may declare its own `snapshot` field — under
  `useDefineForClassFields` a redeclaration defines over the base's.

## The gotcha that forces the lazy snapshot

The obvious form — a base constructor doing `this.snapshot = this.buildSnapshot()` —
**does not work here**, and fails silently rather than loudly.

`tsconfig.json` sets `useDefineForClassFields: true`. Under define semantics, base
field initialisers and the base constructor body both run at `super()`, *before* any
derived field initialiser. So a base constructor calling `this.buildSnapshot()`
captures an object built from derived fields that are all still `undefined` — and
worse, a derived class redeclaring `snapshot` would then `[[Define]]` over whatever
the base assigned.

The `??=` form above sidesteps it completely: nothing is built until the first
`getSnapshot()`, which happens during a render, long after every constructor has run.
It also removes the ordering hazard that exists today in `PlayerController`, where
the snapshot must be built after `restoreSettings()` and before the subscriptions.

**Verify one behavioural difference before shipping:** the snapshot is currently built
*eagerly*, at the moment of the change, and would become built *lazily*, at the moment
of the read. `PlayerController.buildSnapshot` reads live mutable state off the audio
element (`currentTime`, `volume`, `duration`), so its values would be sampled slightly
later than they are now. This should be harmless — arguably more correct — but it is
the one thing here that is not a pure refactor.

## What must NOT be folded into the base

- **`apply()`.** It looks shared and isn't. `Equalizer.apply()` returns immediately
  when there is no audio context; `Effects.apply()` must write the element's
  `playbackRate` *before* that bail, because speed applies with no graph at all.
  `PlayerController` has no `apply()` at all. Leave it out of the base entirely —
  `commit()` calling it is the subclass's business.
- **`hooks/useEqualizer.ts` and `hooks/useEffects.ts`.** They are 1:1 structural
  duplicates, and collapsing them into a generic `useStore(store)` would make each
  hook two lines instead of three and add a file. Each currently names a domain
  concept and returns `{ state, thing }`, which both call sites use. Leave them.
- **`GraphStage`** (`player/audioGraph.ts`) is a separate axis and already exists.
  `PlayerController` is not a graph stage; `Equalizer` and `Effects` are. Don't try to
  merge the two hierarchies.

## Why it is worth doing at all

Not the line count — twelve lines times three is not the point. It is that
"external store" is currently a **convention** three classes follow by hand, with
nothing checking that a fourth would. `abstract buildSnapshot(): T` plus a `protected
emit()` turns it into something the compiler enforces, which is the move this codebase
already makes elsewhere (`Record<MainViewName, ComponentType>` in `App.tsx`,
`Platforms.tsx`'s derived toggle order, `storage.equalizer.gains` validating against
`EQ_BANDS.length`).

## Scope and risk

`PlayerController` is the most load-bearing class in the app — the transport, the
queue, persistence and the snapshot every view subscribes to. That is why this should
land as its own change with its own justification, and not be folded into unrelated
feature work. It touches no behaviour, so it is reviewable as a pure refactor only if
nothing else is happening in the same diff.

## Verification

No test framework exists in this repo.

- `bunx tsc --noEmit`, then `bun run vite:build`.
- `bun .claude/skills/preview/render.ts library discover settings --still` and compare
  against a render taken before the change — the images should be identical, since
  nothing user-visible moves.
- `bun run dev:hmr` with a backend (`bun run scripts/test-server.ts`, `test`/`test` on
  port 8790) and check the three stores still drive their UI: the seek bar advances,
  the EQ faders move the sound, the effects popover's sliders take effect, and all of
  it survives a reload (each store restores from `lib/storage`).
- Watch specifically for a store that renders its *initial* state wrong — that is what
  a botched lazy snapshot would look like.

## Repo conventions the implementer must follow

Read the root `CLAUDE.md` and `src/mainview/player/CLAUDE.md` first. In short: tabs for
indentation; comments say what the code can't and are written in the present tense
about what is there, never about what was replaced; the `CLAUDE.md` files carry
structure and cross-file rules only, never walkthroughs. If this change lands, the
`player/CLAUDE.md` line about the equalizer and effects being "stores of their own"
is the one that may need a word about the shared base — and nothing more.
