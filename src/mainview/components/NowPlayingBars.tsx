// Every bar runs the same full bounce at the same duration; the negative
// delays stagger them a quarter cycle apart, so the peak travels across the
// bars as one continuous wave instead of the bars pulsing in lockstep or
// drifting apart.
const BAR_DELAYS = ["0s", "-0.3s", "-0.6s", "-0.9s"];

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
			{BAR_DELAYS.map((delay) => (
				<span
					key={delay}
					className="h-full w-[2px] origin-bottom rounded-full bg-primary animate-equalize motion-reduce:animate-none"
					style={{ animationDelay: delay }}
				/>
			))}
		</span>
	);
}
