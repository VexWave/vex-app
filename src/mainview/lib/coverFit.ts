/**
 * How a search result's thumbnail should meet its square frame.
 *
 * YouTube hands out 16:9 stills, but a large share of the music on it is
 * uploaded as an "art track": a square cover sitting in the middle of the frame
 * with the sides filled in flat. Contained in a square frame that cover is
 * bordered twice — by the platform's bars and then by ours — and ends up drawn
 * at a fraction of the space it had. Cropping the sides away gives it the whole
 * sleeve back. Doing the same to a real still would cut a quarter of the picture
 * off, so it happens only where the sides are provably dead space.
 *
 * The test asks one narrow question: are the exact bands a centred square would
 * leave each a single flat colour? Nothing subtler is attempted — a wrong "yes"
 * silently destroys part of a picture, while a wrong "no" only leaves the
 * contained rendering everything falls back to anyway.
 */
export type CoverFit = "contain" | "cover";

/** Sample width the image is scaled down to before its bands are read. */
const SAMPLE_WIDTH = 64;
/**
 * Rows and columns skipped at each band's outer edge and at the seam. Scaling
 * averages ~10 source columns into one, so the seam's own colour bleeds a column
 * inwards, and JPEG ringing does the same along the picture's border.
 */
const INSET = 1;
/** How far a band pixel may sit from the band's mean, per channel of 255. */
const FLAT_TOLERANCE = 12;
/** Share of a band allowed past that, for a logo or a stray artefact. */
const OUTLIER_SHARE = 0.02;

/**
 * Measured fits by URL. A search's results outlive the cards that draw them
 * (scrolling, a re-render, coming back to the view), and the answer for a URL
 * can't change. Bounded because a session is long and every search adds a page
 * of URLs that will never be asked about again; Map iterates in insertion order,
 * so the front of it is the search furthest behind.
 */
const measured = new Map<string, CoverFit>();
const CACHE_LIMIT = 600;

let scratch: CanvasRenderingContext2D | null = null;

/** The fit already measured for this URL, if one has been. */
export function knownCoverFit(url: string): CoverFit | undefined {
	return measured.get(url);
}

/** Measures `img` — which must have loaded — and remembers the answer. */
export function measureCoverFit(url: string, img: HTMLImageElement): CoverFit {
	const cached = measured.get(url);
	if (cached !== undefined) return cached;

	const fit = measure(img);
	if (measured.size >= CACHE_LIMIT) {
		const oldest = measured.keys().next().value;
		if (oldest !== undefined) measured.delete(oldest);
	}
	measured.set(url, fit);
	return fit;
}

function measure(img: HTMLImageElement): CoverFit {
	const width = img.naturalWidth;
	const height = img.naturalHeight;
	if (width === 0 || height === 0) return "contain";
	// Square already, near enough: the two fits render the same thing, and
	// "cover" says so, which spares the frame its blurred backing layer.
	if (Math.abs(width - height) <= width * 0.02) return "cover";

	const sampleHeight = Math.max(1, Math.round((SAMPLE_WIDTH * height) / width));
	const band = Math.round((SAMPLE_WIDTH - sampleHeight) / 2);
	// Portrait (a negative band) or too close to square to read one: there is no
	// dead space to take, and cropping would eat the picture instead.
	if (band <= 2 * INSET) return "contain";

	const ctx = context(sampleHeight);
	ctx.drawImage(img, 0, 0, SAMPLE_WIDTH, sampleHeight);

	let pixels: Uint8ClampedArray;
	try {
		pixels = ctx.getImageData(0, 0, SAMPLE_WIDTH, sampleHeight).data;
	} catch {
		// Insurance only: an image that fired `load` under crossOrigin="anonymous"
		// is CORS-clean, so nothing on the caller's path taints this canvas.
		return "contain";
	}

	const flat =
		isFlat(pixels, sampleHeight, INSET, band - INSET) &&
		isFlat(pixels, sampleHeight, SAMPLE_WIDTH - band + INSET, SAMPLE_WIDTH - INSET);
	return flat ? "cover" : "contain";
}

/** Whether every pixel in a column range is the same colour, give or take. */
function isFlat(
	pixels: Uint8ClampedArray,
	sampleHeight: number,
	fromX: number,
	toX: number,
): boolean {
	const fromY = INSET;
	const toY = sampleHeight - INSET;
	let sumR = 0;
	let sumG = 0;
	let sumB = 0;
	let count = 0;
	for (let y = fromY; y < toY; y++) {
		for (let x = fromX; x < toX; x++) {
			const i = (y * SAMPLE_WIDTH + x) * 4;
			sumR += pixels[i]!;
			sumG += pixels[i + 1]!;
			sumB += pixels[i + 2]!;
			count++;
		}
	}
	if (count === 0) return false;

	const meanR = sumR / count;
	const meanG = sumG / count;
	const meanB = sumB / count;
	let outliers = 0;
	for (let y = fromY; y < toY; y++) {
		for (let x = fromX; x < toX; x++) {
			const i = (y * SAMPLE_WIDTH + x) * 4;
			if (
				Math.abs(pixels[i]! - meanR) > FLAT_TOLERANCE ||
				Math.abs(pixels[i + 1]! - meanG) > FLAT_TOLERANCE ||
				Math.abs(pixels[i + 2]! - meanB) > FLAT_TOLERANCE
			) {
				outliers++;
			}
		}
	}
	return outliers <= count * OUTLIER_SHARE;
}

/** One canvas for all of them — a grid of results measures twenty images. */
function context(height: number): CanvasRenderingContext2D {
	scratch ??= document
		.createElement("canvas")
		.getContext("2d", { willReadFrequently: true })!;
	scratch.canvas.width = SAMPLE_WIDTH;
	scratch.canvas.height = height;
	return scratch;
}
