import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useAudioGlow } from "@/hooks/useAudioGlow";
import { cn } from "@/lib/utils";
import type { PlayerController } from "@/player/PlayerController";

const FADE_MS = 700;

type CoverLayer = { id: number; url: string; loaded: boolean };

/** Topmost layer — the one being faded in, or the only one left. */
function topLayer(layers: CoverLayer[]): CoverLayer | undefined {
	return layers[layers.length - 1] as CoverLayer | undefined;
}

/**
 * Decorative cover art behind the player bar: blurred hard and covered by a
 * scrim so the controls keep their contrast even against bright artwork, with
 * its brightness following the music (see `useAudioGlow`).
 *
 * Sits behind the bar's own `bg-card` — a negative z-index paints over the
 * parent's background but under its in-flow content — so the bar keeps its
 * normal look while a track has no cover.
 *
 * Track changes cross-fade. The incoming cover is stacked *over* the outgoing
 * one and fades from 0 to 1 while the outgoing one stays fully opaque; fading
 * both at once would dip through the bare card colour mid-way.
 *
 * That rests on one invariant: a layer at full opacity must hide the layer
 * below it *exactly*, or pruning the hidden one shows up as a jump in
 * brightness right as the fade ends. Two things buy it, and both are load
 * bearing — the constant `opacity-70` sits on the shared wrapper rather than
 * on the layers, and each layer is overscanned past the blur's soft edge
 * (below).
 *
 * Memoised because the player bar re-renders on every timeupdate, while this
 * subtree only cares about the artwork and whether audio is running.
 */
export const CoverBackdrop = memo(function CoverBackdrop({
	coverUrl,
	controller,
	isPlaying,
}: {
	coverUrl: string | undefined;
	controller: PlayerController;
	isPlaying: boolean;
}) {
	// Applied to the layer wrapper, which leaves the scrim above it untouched —
	// the glow lifts the art rather than thinning out what keeps the controls
	// readable. It also sits above the cross-fade, so both layers brighten as
	// one composited image and the invariant above still holds.
	const glowRef = useAudioGlow(controller, isPlaying);
	const [layers, setLayers] = useState<CoverLayer[]>([]);
	const nextId = useRef(0);

	// A track without artwork fades the backdrop out instead of cutting it, so
	// its layer stays mounted (at opacity 0) until the prune below drops it.
	const fadingOut = coverUrl === undefined;
	const top = topLayer(layers);
	const topId = top?.id;
	const topLoaded = top?.loaded ?? false;

	// Reveals a layer, but only once the browser has actually painted it at
	// opacity 0: a cover that is already cached fires `load` in the same frame
	// its element mounts, and a style change that was never painted starts no
	// transition at all — the cover would just snap in. Two frames, because a
	// single rAF callback can still run before that frame's paint.
	const settle = useCallback((id: number) => {
		requestAnimationFrame(() =>
			requestAnimationFrame(() =>
				// Returning `prev` unchanged lets React bail out of the
				// re-render — this can fire repeatedly for the same layer.
				setLayers((prev) =>
					prev.some((layer) => layer.id === id && !layer.loaded)
						? prev.map((l) => (l.id === id ? { ...l, loaded: true } : l))
						: prev,
				),
			),
		);
	}, []);

	useEffect(() => {
		if (coverUrl === undefined) return;
		// Allocated out here because the updater below has to stay pure —
		// StrictMode calls it twice, which would burn two ids per change.
		const id = nextId.current++;
		setLayers((prev) => {
			const current = topLayer(prev);
			// Same artwork: keep the existing layer, so a fade-out still in
			// flight reverses smoothly rather than restarting from zero.
			if (current?.url === coverUrl) return prev;
			const incoming = { id, url: coverUrl, loaded: false };
			// An incoming layer that never became visible is replaced rather
			// than stacked, so skipping through tracks can't pile up layers.
			return current && !current.loaded
				? [...prev.slice(0, -1), incoming]
				: [...prev, incoming];
		});
	}, [coverUrl]);

	// Drop the layers underneath once the fade that hid them has finished. Any
	// new top layer re-runs this effect and so restarts the timer.
	useEffect(() => {
		// Fading out, every layer is on its way out; otherwise only the ones the
		// top layer has covered up are stale.
		const staleCount = layers.length - (fadingOut ? 0 : 1);
		const faded = fadingOut || topLoaded;
		if (staleCount < 1 || !faded) return;
		const timer = setTimeout(
			() => setLayers((prev) => (fadingOut ? [] : prev.slice(-1))),
			FADE_MS,
		);
		return () => clearTimeout(timer);
	}, [layers.length, fadingOut, topId, topLoaded]);

	if (layers.length === 0) return null;

	return (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
		>
			<div ref={glowRef} className="absolute inset-0 opacity-70">
				{layers.map((layer) => (
					// -inset-40 (160px) is the overscan that keeps a layer opaque
					// wherever it is visible. blur() ramps an element's alpha down
					// towards its own edges over roughly 3x the radius, so blur-2xl
					// (40px) only reaches full alpha ~120px inside the box — and a
					// translucent layer lets the one beneath it add brightness,
					// which then disappears as a visible jump the moment that lower
					// layer is pruned. The overscan is in fixed pixels and sits on
					// an unfiltered wrapper: `scale` cannot do this job, because
					// transforms apply after filters and would enlarge the blur
					// along with the image.
					<div
						key={layer.id}
						style={{ transitionDuration: `${FADE_MS}ms` }}
						className={cn(
							// bg-card: the same guarantee for a cover with an alpha
							// channel, on the one box the blur can't soften.
							"absolute -inset-40 bg-card transition-opacity",
							layer.loaded && !fadingOut ? "opacity-100" : "opacity-0",
						)}
					>
						<img
							src={layer.url}
							alt=""
							ref={(el) => {
								// An already-decoded image may never fire `load` where
								// React can hear it.
								if (!el?.complete || layer.loaded) return;
								settle(layer.id);
							}}
							onLoad={() => settle(layer.id)}
							// A cover that fails to load still has to settle, or the
							// layer beneath it would never be pruned.
							onError={() => settle(layer.id)}
							className="h-full w-full object-cover blur-2xl"
						/>
					</div>
				))}
			</div>
			<div className="absolute inset-0 bg-gradient-to-t from-background/85 via-background/70 to-background/75" />
		</div>
	);
});
