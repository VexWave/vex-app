/**
 * What level a track's own material sits at, read from the head of its file.
 *
 * What saturation costs in level swings by several dB across the range real
 * masters are cut at, so `Drive`'s makeup needs the track's own number rather
 * than an average of them. Read once before the track is heard, and standing for
 * its whole length — a level taken off the signal as it plays would ride the
 * track's own dynamics back at it.
 */

/**
 * The proxy's sibling route to a track's audio URL. How much of the file it
 * answers with, and why it is not a second download, are both `bun/StreamProxy`'s.
 * What matters here is that the bound is a byte count and not a duration, so a
 * head is a very different amount of audio per format — lossless buys the fewest
 * seconds of it, and is therefore what `BLOCK_SECONDS` has to fit inside.
 */
const HEAD_PATH = "/head";

/**
 * The window a level is taken over, the level being the loudest of them. Three
 * seconds is long enough that no single hit fills a window at any tempo, and
 * short enough that a loud section holds several, so the loudest lands inside one
 * rather than straddling its edge.
 *
 * Loudest rather than average is what makes a leading silence, a fade-in or the
 * gap before the music cost nothing: the compensation has to be right where the
 * saturator bites hardest, not where the track typically sits.
 */
const BLOCK_SECONDS = 3;

/**
 * Under this a head is silence rather than a quiet track. Read as no answer at
 * all, which keeps a zero out of `Drive`'s model — its integral is undefined
 * there, and an `AudioParam` refuses the resulting NaN.
 */
const FLOOR_RMS = 10 ** (-40 / 20);

/** What `decodeAudioData` resamples to, and so what a block's length is figured at. */
const DECODE_RATE = 44100;

/**
 * An OfflineAudioContext decodes without a user gesture and without touching the
 * context the track plays through — and the slider can be raised long before
 * anything has played, when there is no such context to borrow. `decodeAudioData`
 * does not consume it, so every scan shares this one.
 */
let decoder: OfflineAudioContext | null = null;

/**
 * Settled levels by stream URL; null is a settled failure, kept so an unscannable
 * track is not fetched again on every play. Proxy URLs carry a port and a secret
 * from this run, so nothing here outlives the process.
 */
const measured = new Map<string, number | null>();

/** RMS of the loudest block, or null when the head decodes to silence. */
function loudestBlock(buffer: AudioBuffer): number | null {
	const channels: Float32Array[] = [];
	for (let c = 0; c < buffer.numberOfChannels; c++) {
		channels.push(buffer.getChannelData(c));
	}
	// A track shorter than the window is one block of whatever it has.
	const block = Math.min(
		Math.floor(BLOCK_SECONDS * buffer.sampleRate),
		buffer.length,
	);
	if (block === 0) return null;

	let loudest = 0;
	for (let start = 0; start + block <= buffer.length; start += block) {
		let square = 0;
		for (const data of channels) {
			for (let i = start; i < start + block; i++) square += data[i] * data[i];
		}
		// Mean power across the channels, not their sum: the shaper reads each of
		// them against the same curve, so what drives it is the level they share.
		const rms = Math.sqrt(square / (block * channels.length));
		if (rms > loudest) loudest = rms;
	}
	return loudest >= FLOOR_RMS ? loudest : null;
}

/**
 * The program RMS of the track at `url`, or null when there is no answer — which
 * the caller reads as "carry on with the nominal level".
 *
 * Never rejects and never throws: a level is an improvement on an assumption, so
 * every way of failing to get one leaves the assumption standing. Decoding a
 * truncated body is the normal case here, and the containers that won't decode
 * from one — an mp4 carrying its index at the end, a wav promising data it never
 * delivers — fail here rather than anywhere the track can hear it.
 */
export async function measureProgramLevel(
	url: string,
	signal: AbortSignal,
): Promise<number | null> {
	const settled = measured.get(url);
	if (settled !== undefined) return settled;

	try {
		const response = await fetch(url + HEAD_PATH, { signal });
		if (!response.ok) {
			void response.body?.cancel();
			measured.set(url, null);
			return null;
		}
		// decodeAudioData detaches what it is handed, so these bytes are read here
		// and nowhere after.
		const bytes = await response.arrayBuffer();
		// The decode and the scan after it are the expensive half, and a burst of
		// skips is what puts several of them on the render thread at once.
		if (signal.aborted) return null;
		decoder ??= new OfflineAudioContext(1, 1, DECODE_RATE);
		const buffer = await decoder.decodeAudioData(bytes);
		const level = loudestBlock(buffer);
		measured.set(url, level);
		return level;
	} catch {
		// An abort is a track being left rather than a verdict on this one, so it
		// stays unsettled for the next time the track comes round.
		if (!signal.aborted) measured.set(url, null);
		return null;
	}
}
