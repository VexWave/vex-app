// Throwaway dev server for manually testing login + gzip track upload.
// Run: bun run scripts/test-server.ts  (credentials: test / test)
import { TrackSchema } from "../contract/contract";

const PORT = 8790;
const tokens = new Set<string>();

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
				const auth = req.headers.get("authorization");
				if (!auth || !tokens.has(auth)) {
					return new Response("Invalid or missing token", { status: 401 });
				}
				const parsed = TrackSchema.safeParse(await req.json());
				if (!parsed.success) {
					return new Response(parsed.error.message, { status: 400 });
				}
				const { title, duration, compressed_data } = parsed.data;
				const raw = Bun.gunzipSync(new Uint8Array(compressed_data));
				const hash = new Bun.CryptoHasher("sha256")
					.update(raw)
					.digest("hex");
				console.log(
					`postTrack ok: "${title}" duration=${duration}s ` +
						`compressed=${compressed_data.byteLength}B raw=${raw.byteLength}B sha256=${hash}`,
				);
				return new Response("ok");
			},
		},
	},
	fetch: () => new Response("not found", { status: 404 }),
});

console.log(`test server listening on http://localhost:${PORT}`);
