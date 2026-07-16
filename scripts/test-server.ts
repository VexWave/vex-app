// Throwaway dev server for manually testing login, gzip track upload and
// progressive streaming. Run: bun run scripts/test-server.ts
// (credentials: test / test; uploaded tracks live in memory)
import {
	ApiContract,
	CreateArtistRequest,
	CreateTrackRequest,
	DeleteByIdRequest,
	EditArtistRequest,
	EditTrackRequest,
	artistImagePath,
	trackImagePath,
} from "../contract/contract";

const PORT = 8790;
const tokens = new Set<string>();

interface StoredTrack {
	id: number;
	title: string;
	/** Track length in milliseconds. */
	duration: number;
	artists: string[];
	contentType: string;
	data: Uint8Array;
	/** Raw cover-image bytes, served from `/track/:id/image`. */
	cover?: Uint8Array;
}

let nextTrackId = 1;
const tracks = new Map<number, StoredTrack>();

interface StoredArtist {
	id: number;
	name: string;
	/** Raw image bytes, stored as-is; served from `/artist/:id/image`. */
	image?: Uint8Array;
}

let nextArtistId = 1;
const artists = new Map<number, StoredArtist>();

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
				const parsed = CreateTrackRequest.safeParse(await req.json());
				if (!parsed.success) {
					return new Response(parsed.error.message, { status: 400 });
				}
				const { title, duration, artistIds, compressed_data, cover } =
					parsed.data;
				const raw = Bun.gunzipSync(new Uint8Array(compressed_data));
				const id = nextTrackId++;
				// Resolve artist ids to names, dropping ids that don't exist.
				const artistNames = (artistIds ?? [])
					.map((artistId) => artists.get(artistId)?.name)
					.filter((name): name is string => name !== undefined);
				tracks.set(id, {
					id,
					title,
					duration,
					artists: artistNames,
					contentType: sniffAudioType(raw),
					data: raw,
					cover: cover ? new Uint8Array(cover) : undefined,
				});
				console.log(
					`postTrack ok: #${id} "${title}" duration=${duration}ms ` +
						`compressed=${compressed_data.byteLength}B raw=${raw.byteLength}B` +
						(cover ? ` cover=${cover.byteLength}B` : "") +
						(artistNames.length ? ` artists=${artistNames.join(", ")}` : ""),
				);
				return new Response("ok");
			},
		},
		"/editTrack": {
			POST: async (req) => {
				if (!authorized(req)) {
					return new Response("Invalid or missing token", { status: 401 });
				}
				const parsed = EditTrackRequest.safeParse(await req.json());
				if (!parsed.success) {
					return new Response(parsed.error.message, { status: 400 });
				}
				const { id, title, artistIds, cover } = parsed.data;
				const track = tracks.get(id);
				if (!track) return new Response("not found", { status: 404 });
				if (title !== undefined) track.title = title;
				if (artistIds !== undefined) {
					track.artists = artistIds
						.map((artistId) => artists.get(artistId)?.name)
						.filter((name): name is string => name !== undefined);
				}
				if (cover === null) track.cover = undefined;
				else if (cover !== undefined) track.cover = new Uint8Array(cover);
				console.log(
					`editTrack ok: #${id} "${track.title}"` +
						(cover === null
							? " cover=removed"
							: cover !== undefined
								? ` cover=${cover.byteLength}B`
								: ""),
				);
				return new Response("ok");
			},
		},
		"/postArtist": {
			POST: async (req) => {
				if (!authorized(req)) {
					return new Response("Invalid or missing token", { status: 401 });
				}
				const parsed = CreateArtistRequest.safeParse(await req.json());
				if (!parsed.success) {
					return new Response(parsed.error.message, { status: 400 });
				}
				const { name, image } = parsed.data;
				const id = nextArtistId++;
				artists.set(id, {
					id,
					name,
					image: image ? new Uint8Array(image) : undefined,
				});
				console.log(
					`postArtist ok: #${id} "${name}"` +
						(image ? ` image=${image.byteLength}B` : ""),
				);
				return new Response("ok");
			},
		},
		"/editArtist": {
			POST: async (req) => {
				if (!authorized(req)) {
					return new Response("Invalid or missing token", { status: 401 });
				}
				const parsed = EditArtistRequest.safeParse(await req.json());
				if (!parsed.success) {
					return new Response(parsed.error.message, { status: 400 });
				}
				const { id, name, image } = parsed.data;
				const artist = artists.get(id);
				if (!artist) return new Response("not found", { status: 404 });
				if (name !== undefined) artist.name = name;
				if (image === null) artist.image = undefined;
				else if (image !== undefined) artist.image = new Uint8Array(image);
				console.log(
					`editArtist ok: #${id} "${artist.name}"` +
						(image === null
							? " image=removed"
							: image !== undefined
								? ` image=${image.byteLength}B`
								: ""),
				);
				return new Response("ok");
			},
		},
		"/deleteArtist": {
			POST: async (req) => {
				if (!authorized(req)) {
					return new Response("Invalid or missing token", { status: 401 });
				}
				const parsed = DeleteByIdRequest.safeParse(await req.json());
				if (!parsed.success || !artists.delete(parsed.data.id)) {
					return new Response("not found", { status: 404 });
				}
				console.log(`deleteArtist ok: #${parsed.data.id}`);
				return new Response("ok");
			},
		},
		"/artists": {
			GET: (req) => {
				if (!authorized(req)) {
					return new Response("Invalid or missing token", { status: 401 });
				}
				// Never inline image bytes: expose the image route's path instead,
				// and only for artists that actually have an avatar.
				return Response.json(
					[...artists.values()].map(({ id, name, image }) => ({
						id,
						name,
						imageUrl: image ? artistImagePath(id) : undefined,
					})),
				);
			},
		},
		// ApiContract.getArtistImage ("/artist/:id/image"): raw stored image
		// bytes, public (no auth) per the contract.
		[ApiContract.getArtistImage.path]: {
			GET: (req: Bun.BunRequest<typeof ApiContract.getArtistImage.path>) => {
				const artist = artists.get(Number(req.params.id));
				if (!artist?.image) return new Response("not found", { status: 404 });
				return new Response(artist.image, {
					headers: { "content-type": "application/octet-stream" },
				});
			},
		},
		// ApiContract.getTrackImage ("/track/:id/image"): raw stored cover-image
		// bytes, public (no auth) per the contract.
		[ApiContract.getTrackImage.path]: {
			GET: (req: Bun.BunRequest<typeof ApiContract.getTrackImage.path>) => {
				const track = tracks.get(Number(req.params.id));
				if (!track?.cover) return new Response("not found", { status: 404 });
				return new Response(track.cover, {
					headers: { "content-type": "application/octet-stream" },
				});
			},
		},
		"/tracks": {
			GET: (req) => {
				if (!authorized(req)) {
					return new Response("Invalid or missing token", { status: 401 });
				}
				return Response.json(
					[...tracks.values()].map(
						({ id, title, duration, artists, cover }) => ({
							id,
							title,
							duration,
							artists,
							coverUrl: cover ? trackImagePath(id) : undefined,
						}),
					),
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
