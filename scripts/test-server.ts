// Throwaway dev server for manually testing login, gzip track upload and
// progressive streaming. Run: bun run scripts/test-server.ts
// (credentials: test / test; uploaded tracks live in memory)
import { ApiContract, TrackSchema } from "../contract/contract";

const PORT = 8790;
const tokens = new Set<string>();

interface StoredTrack {
	id: number;
	title: string;
	duration: number;
	artists: string[];
	contentType: string;
	data: Uint8Array;
}

let nextTrackId = 1;
const tracks = new Map<number, StoredTrack>();

function authorized(req: Request): boolean {
	const auth = req.headers.get("authorization");
	return auth !== null && tokens.has(auth);
}

/** Best-effort container sniffing so the audio element gets a real MIME. */
function sniffAudioType(data: Uint8Array): string {
	const ascii = (start: number, length: number) =>
		String.fromCharCode(...data.subarray(start, start + length));
	if (ascii(0, 3) === "ID3") return "audio/mpeg";
	if (data.length > 1 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) {
		return "audio/mpeg"; // raw MPEG frame sync
	}
	if (ascii(0, 4) === "fLaC") return "audio/flac";
	if (ascii(0, 4) === "OggS") return "audio/ogg";
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
	if (ascii(4, 4) === "ftyp") return "audio/mp4";
	return "application/octet-stream"; // Chromium sniffs media content anyway
}

/**
 * Parse a single `bytes=` range. null → serve the full file (no/unsupported
 * header); "unsatisfiable" → 416.
 */
function parseRange(
	header: string | null,
	size: number,
): { start: number; end: number } | null | "unsatisfiable" {
	if (!header) return null;
	const match = header.match(/^bytes=(\d*)-(\d*)$/);
	if (!match) return null; // multi-range etc. → fall back to a full 200
	const [, startRaw, endRaw] = match;
	if (startRaw === "" && endRaw === "") return null;
	if (startRaw === "") {
		// Suffix range: the last N bytes.
		const suffix = Number(endRaw);
		if (suffix === 0) return "unsatisfiable";
		return { start: Math.max(size - suffix, 0), end: size - 1 };
	}
	const start = Number(startRaw);
	// Reversed range (last-byte-pos < first-byte-pos): invalid spec per
	// RFC 7233 §2.1 — ignore the header (full 200), don't answer 416.
	// 416 is only for a start at/beyond the resource size.
	if (endRaw !== "" && Number(endRaw) < start) return null;
	if (start >= size) return "unsatisfiable";
	return { start, end: endRaw === "" ? size - 1 : Math.min(Number(endRaw), size - 1) };
}

Bun.serve({
	port: PORT,
	routes: {
		"/login": {
			POST: async (req) => {
				const { username, password } = (await req.json()) as {
					username?: string;
					password?: string;
				};
				if (username !== "test" || password !== "test") {
					return new Response("Invalid credentials", { status: 401 });
				}
				const token = crypto.randomUUID();
				tokens.add(token);
				console.log(`login ok, issued token ${token}`);
				return Response.json({ token });
			},
		},
		"/postTrack": {
			POST: async (req) => {
				if (!authorized(req)) {
					return new Response("Invalid or missing token", { status: 401 });
				}
				const parsed = TrackSchema.safeParse(await req.json());
				if (!parsed.success) {
					return new Response(parsed.error.message, { status: 400 });
				}
				const { title, duration, compressed_data } = parsed.data;
				const raw = Bun.gunzipSync(new Uint8Array(compressed_data));
				const id = nextTrackId++;
				tracks.set(id, {
					id,
					title,
					duration,
					artists: [],
					contentType: sniffAudioType(raw),
					data: raw,
				});
				console.log(
					`postTrack ok: #${id} "${title}" duration=${duration}s ` +
						`compressed=${compressed_data.byteLength}B raw=${raw.byteLength}B`,
				);
				return new Response("ok");
			},
		},
		"/tracks": {
			GET: (req) => {
				if (!authorized(req)) {
					return new Response("Invalid or missing token", { status: 401 });
				}
				return Response.json(
					[...tracks.values()].map(({ id, title, duration, artists }) => ({
						id,
						title,
						duration,
						artists,
					})),
				);
			},
		},
		// ApiContract.getTrackAudio ("/track/:id/audio" — ts-rest and Bun share
		// the :param syntax): decompressed bytes with Accept-Ranges + 206
		// support so clients can start playing before the download finishes
		// and seek instantly.
		[ApiContract.getTrackAudio.path]: {
			GET: (req: Bun.BunRequest<typeof ApiContract.getTrackAudio.path>) => {
				if (!authorized(req)) {
					return new Response("Invalid or missing token", { status: 401 });
				}
				const track = tracks.get(Number(req.params.id));
				if (!track) return new Response("not found", { status: 404 });
				const size = track.data.byteLength;
				const range = parseRange(req.headers.get("range"), size);
				if (range === "unsatisfiable") {
					return new Response("range not satisfiable", {
						status: 416,
						headers: { "content-range": `bytes */${size}` },
					});
				}
				const baseHeaders = {
					"content-type": track.contentType,
					"accept-ranges": "bytes",
				};
				if (!range) {
					console.log(`stream #${track.id} full ${size}B`);
					return new Response(track.data, { headers: baseHeaders });
				}
				console.log(
					`stream #${track.id} bytes ${range.start}-${range.end}/${size}`,
				);
				return new Response(track.data.subarray(range.start, range.end + 1), {
					status: 206,
					headers: {
						...baseHeaders,
						"content-range": `bytes ${range.start}-${range.end}/${size}`,
					},
				});
			},
		},
	},
	fetch: () => new Response("not found", { status: 404 }),
});

console.log(`test server listening on http://localhost:${PORT}`);
