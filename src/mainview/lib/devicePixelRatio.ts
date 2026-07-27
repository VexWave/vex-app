/**
 * Publishes the webview's device pixel ratio as `--dpr` on `<html>` and keeps
 * it current.
 *
 * CSS can't see the device pixel grid, and anything that has to land on it
 * exactly needs to — see the now-playing ring in index.css, which rounds its
 * band and gap to whole device pixels off this value. The inline property
 * this sets beats the `--dpr: 1` the stylesheet declares for itself.
 *
 * There is no DPR change event. The idiom is a media query pinned to the
 * *current* ratio — which can then only ever stop matching — re-armed each
 * time it fires; moving the window to a monitor on a different Windows scale
 * factor is what fires it. `resize` is a second trigger for the same thing,
 * because this app's startup needs one: bun nudges the window's size once CEF
 * is up, precisely because CEF settles on the monitor's scale factor after
 * painting its first frame (see src/bun/index.ts), so the ratio read before
 * that can be stale.
 */
export function watchDevicePixelRatio() {
	let query: MediaQueryList | null = null;
	let published: number | null = null;

	const publish = () => {
		const dpr = window.devicePixelRatio || 1;
		// Resizes outnumber real ratio changes by a wide margin, and rebuilding
		// the query would drop the listener that is about to tell us.
		if (dpr === published) return;
		published = dpr;
		document.documentElement.style.setProperty("--dpr", String(dpr));

		query?.removeEventListener("change", publish);
		query = window.matchMedia(`(resolution: ${dpr}dppx)`);
		query.addEventListener("change", publish);
	};

	publish();
	window.addEventListener("resize", publish);
}
