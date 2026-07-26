// Negative delays stagger the bars into different phases so they read as an
// equalizer immediately, without a synchronized "all bars rise together" start.
const BAR_DELAYS = ["-0.4s", "-0.15s", "-0.6s", "-0.25s"];

/**
 * Little equalizer whose bars bounce to mark the track that's currently
 * playing (the caller only renders it while playback is active). Decorative
 * only (the row is already highlighted), so it's hidden from assistive tech
 * and honours prefers-reduced-motion.
 */
export function NowPlayingBars() {
	return (
		<span
			className="flex h-4 w-4 shrink-0 items-end justify-center gap-[2px]"
			aria-hidden="true"
		>
			{BAR_DELAYS.map((delay, i) => (
				<span
					key={i}
					className="h-full w-[2px] origin-bottom rounded-full bg-primary animate-equalize motion-reduce:animate-none"
					style={{ animationDelay: delay }}
				/>
			))}
		</span>
	);
}
