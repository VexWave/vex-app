import { connect, type Socket } from "node:net";
import { trackImagePath } from "../../contract/contract";
import type { PresenceTrack } from "../shared/rpcSchema";

/**
 * Discord Rich Presence, spoken directly to the desktop client's local IPC
 * socket instead of through a client library.
 *
 * Discord listens on a named pipe (Windows) or a unix socket (macOS, Linux) and
 * speaks a framed JSON protocol: a little-endian u32 opcode and a u32 payload
 * length, then the UTF-8 JSON body. A connection opens with a HANDSHAKE naming
 * the application id and becomes usable once Discord answers with a READY
 * dispatch; from there each presence update is a SET_ACTIVITY command carried
 * in a FRAME.
 *
 * The whole integration is best-effort and quiet by design. Discord not being
 * installed or not running is the ordinary case rather than a fault, so a
 * failed connection only schedules another attempt — nothing surfaces to the
 * app or the user.
 */

/**
 * Discord application ("client") id the presence is published under. Rich
 * Presence is always attributed to an application, so this has to be a real id
 * from https://discord.com/developers/applications: its name is what Discord
 * prints as "Listening to …", and its uploaded art assets are what the keys
 * below resolve against. Empty disables the integration outright.
 */
const APPLICATION_ID = process.env.VEX_DISCORD_APP_ID?.trim() || "";

/**
 * Art asset keys, as uploaded under the application's Rich Presence → Art
 * Assets. They are optional: an asset that was never uploaded simply renders no
 * image, which is why nothing here has to check whether they exist. The logo
 * also stands in for the cover whenever `coverUrl` can't produce one.
 */
const LOGO_ASSET = "vexwave";
const PLAYING_ASSET = "playing";
const PAUSED_ASSET = "paused";

// --- Wire protocol -------------------------------------------------------

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

/** Little-endian u32 opcode followed by a little-endian u32 payload length. */
const HEADER_BYTES = 8;

/**
 * Anything longer than this is a desynced stream rather than a real frame —
 * Discord's own payloads are a few hundred bytes. Guards against allocating
 * against a garbage length if the connection ever loses framing.
 */
const MAX_FRAME_BYTES = 1 << 20;

/** Discord occupies one socket per running client, numbered 0-9. */
const MAX_SOCKET_INDEX = 9;

/** Activity types Discord accepts over RPC; a music player is "Listening". */
const ACTIVITY_PLAYING = 0;
const ACTIVITY_LISTENING = 2;

/**
 * SET_ACTIVITY is limited to 5 updates per 20 seconds. Spacing sends by at
 * least a fifth of that window puts at most 5 in any 20-second stretch, so the
 * limit can't be tripped however hard the user leans on the skip button.
 * Bursts are coalesced rather than queued — see `schedule`.
 */
const MIN_UPDATE_INTERVAL_MS = 5_000;

/** Delay between connection sweeps while no Discord client is answering. */
const RECONNECT_INTERVAL_MS = 10_000;

/** A socket that accepts the handshake but never answers isn't Discord. */
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** Discord rejects `details`/`state` outside this length. */
const MIN_TEXT_LENGTH = 2;
const MAX_TEXT_LENGTH = 128;

interface ActivityAssets {
	large_image?: string;
	large_text?: string;
	small_image?: string;
	small_text?: string;
}

interface Activity {
	type: number;
	details: string;
	state?: string;
	timestamps?: { start: number; end?: number };
	assets: ActivityAssets;
}

export class DiscordPresence {
	private socket: Socket | null = null;
	/** Carries the partial tail of a frame split across reads. */
	private inbox: Buffer = Buffer.alloc(0);
	/** True between Discord's READY dispatch and the socket closing. */
	private ready = false;
	private now: PresenceTrack | null = null;
	/** Start of the current idle stretch, so its elapsed timer survives resends. */
	private idleSince = Date.now();
	private lastSentAt = 0;
	private updateTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
	/** Keeps a down Discord from logging on every sweep. */
	private loggedOffline = false;
	/** One rejected command per connection is enough to explain the problem. */
	private loggedError = false;

	constructor(
		/**
		 * Base URL of the backend the session is logged in to, or null when
		 * logged out — the origin cover URLs are built against.
		 */
		private readonly resolveBaseUrl: () => string | null,
		private readonly applicationId: string = APPLICATION_ID,
	) {}

	/**
	 * Begins connecting, and keeps trying for as long as the app runs. Safe to
	 * call before anything is playing: until then the idle card is what shows.
	 */
	start(): void {
		if (!this.applicationId) {
			console.log(
				"Discord Rich Presence: disabled (no application id — set VEX_DISCORD_APP_ID or fill in APPLICATION_ID).",
			);
			return;
		}
		void this.sweep();
	}

	/**
	 * Points the presence at a track, or at the idle card with `null`. Callers
	 * are expected to have filtered out no-op updates already (the webview only
	 * pushes on a real change), so this always schedules a send.
	 */
	setNowPlaying(now: PresenceTrack | null): void {
		if (!now && this.now) this.idleSince = Date.now();
		this.now = now;
		this.schedule();
	}

	// --- connection ---

	/**
	 * One pass over every socket Discord might be on, stopping at the first that
	 * accepts. A sweep that finds nothing schedules the next one.
	 */
	private async sweep(): Promise<void> {
		for (const path of socketPaths()) {
			const socket = await openSocket(path);
			if (socket) {
				this.attach(socket);
				return;
			}
		}
		if (!this.loggedOffline) {
			console.log(
				"Discord Rich Presence: no Discord client found — retrying in the background.",
			);
			this.loggedOffline = true;
		}
		this.scheduleSweep();
	}

	private scheduleSweep(): void {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.sweep();
		}, RECONNECT_INTERVAL_MS);
		// Never a reason to hold the process open.
		this.reconnectTimer.unref?.();
	}

	private attach(socket: Socket): void {
		this.socket = socket;
		this.inbox = Buffer.alloc(0);
		this.ready = false;
		this.loggedError = false;
		socket.on("data", (chunk: Buffer) => this.receive(chunk));
		socket.on("close", () => this.detach());
		this.writeJson(OP_HANDSHAKE, { v: 1, client_id: this.applicationId });
		// Something is listening on a Discord socket but not answering as one.
		this.handshakeTimer = setTimeout(() => {
			this.handshakeTimer = null;
			if (!this.ready) socket.destroy();
		}, HANDSHAKE_TIMEOUT_MS);
		this.handshakeTimer.unref?.();
	}

	private detach(): void {
		const wasReady = this.ready;
		this.socket = null;
		this.ready = false;
		this.inbox = Buffer.alloc(0);
		this.clearTimer("handshakeTimer");
		this.clearTimer("updateTimer");
		if (wasReady) {
			console.log("Discord Rich Presence: Discord went away, reconnecting.");
			// That line covers the outage; the sweeps it is about to start would
			// otherwise announce the same thing again. A later READY clears this,
			// so the *next* outage is still reported.
			this.loggedOffline = true;
		}
		this.scheduleSweep();
	}

	// --- receiving ---

	private receive(chunk: Buffer): void {
		this.inbox =
			this.inbox.length === 0 ? chunk : Buffer.concat([this.inbox, chunk]);
		// A single read can carry several frames, or a fraction of one.
		for (;;) {
			if (this.inbox.length < HEADER_BYTES) return;
			const opcode = this.inbox.readUInt32LE(0);
			const length = this.inbox.readUInt32LE(4);
			if (length > MAX_FRAME_BYTES) {
				this.socket?.destroy();
				return;
			}
			if (this.inbox.length < HEADER_BYTES + length) return;
			const body = this.inbox.subarray(HEADER_BYTES, HEADER_BYTES + length);
			this.inbox = this.inbox.subarray(HEADER_BYTES + length);
			this.handleFrame(opcode, body);
		}
	}

	private handleFrame(opcode: number, body: Buffer): void {
		if (opcode === OP_PING) {
			// A pong echoes the ping's payload back verbatim.
			this.writeFrame(OP_PONG, body);
			return;
		}
		// Discord closing the connection still surfaces as a socket close, which
		// is what drives the reconnect — nothing else to do here.
		if (opcode === OP_CLOSE) {
			this.socket?.destroy();
			return;
		}
		if (opcode !== OP_FRAME) return;

		let message: { evt?: string; data?: Record<string, unknown> };
		try {
			message = JSON.parse(body.toString("utf8"));
		} catch {
			return;
		}

		if (message.evt === "READY") {
			this.ready = true;
			this.clearTimer("handshakeTimer");
			this.loggedOffline = false;
			const user = message.data?.user as { username?: string } | undefined;
			console.log(
				`Discord Rich Presence: connected${user?.username ? ` as ${user.username}` : ""}.`,
			);
			this.schedule();
			return;
		}

		// Every command is echoed back, so the only replies worth reading are the
		// rejections — a wrong application id shows up here and nowhere else.
		if (message.evt === "ERROR" && !this.loggedError) {
			this.loggedError = true;
			const { code, message: text } = (message.data ?? {}) as {
				code?: number;
				message?: string;
			};
			console.warn(
				`Discord Rich Presence: Discord rejected the update (${code ?? "?"}: ${text ?? "no detail"}).`,
			);
		}
	}

	// --- sending ---

	/**
	 * Queues the current state for delivery under the rate limit. A send already
	 * waiting is left alone rather than re-armed: it reads `this.now` when it
	 * fires, so the newest state goes out and everything in between is dropped.
	 */
	private schedule(): void {
		if (!this.ready || this.updateTimer) return;
		const waited = Date.now() - this.lastSentAt;
		if (waited >= MIN_UPDATE_INTERVAL_MS) {
			this.publish();
			return;
		}
		this.updateTimer = setTimeout(() => {
			this.updateTimer = null;
			this.publish();
		}, MIN_UPDATE_INTERVAL_MS - waited);
		this.updateTimer.unref?.();
	}

	private publish(): void {
		if (!this.ready) return;
		this.lastSentAt = Date.now();
		this.writeJson(OP_FRAME, {
			cmd: "SET_ACTIVITY",
			// Discord clears the presence itself when this process dies.
			args: { pid: process.pid, activity: this.buildActivity() },
			nonce: crypto.randomUUID(),
		});
	}

	private buildActivity(): Activity {
		const now = this.now;
		if (!now) {
			return {
				type: ACTIVITY_PLAYING,
				details: "Idle",
				state: "Nothing playing",
				timestamps: { start: this.idleSince },
				assets: { large_image: LOGO_ASSET, large_text: "VexWave" },
			};
		}

		const activity: Activity = {
			type: ACTIVITY_LISTENING,
			details: clampText(now.title),
			state: now.artist ? clampText(now.artist) : undefined,
			assets: {
				large_image: this.coverUrl(now) ?? LOGO_ASSET,
				large_text: clampText(now.title),
				small_image: now.isPlaying ? PLAYING_ASSET : PAUSED_ASSET,
				small_text: now.isPlaying ? "Playing" : "Paused",
			},
		};

		// Discord derives the progress bar from wall-clock times, so anchoring the
		// start to the current position keeps it honest without further updates.
		// A paused track gets none at all: a bar that kept advancing over stopped
		// audio would be worse than no bar.
		if (now.isPlaying) {
			const start = Date.now() - Math.round(now.positionSec * 1000);
			activity.timestamps =
				now.durationSec > 0
					? { start, end: start + Math.round(now.durationSec * 1000) }
					: { start };
		}
		return activity;
	}

	/**
	 * Public URL of the track's cover, or undefined when Discord has no way to
	 * fetch one. Activity images are rendered server-side — the URL goes to
	 * Discord's media proxy, which loads it from the public internet — so the
	 * webview's loopback StreamProxy URL is useless here and a backend on a LAN
	 * address is unreachable too. The contract's cover route needs no auth, so
	 * for a backend that *is* public the URL works as it stands.
	 */
	private coverUrl(now: PresenceTrack): string | undefined {
		if (!now.hasCover) return undefined;
		const baseUrl = this.resolveBaseUrl();
		if (!baseUrl || !isPubliclyRoutable(baseUrl)) return undefined;
		return baseUrl + trackImagePath(now.id);
	}

	private writeJson(opcode: number, payload: unknown): void {
		this.writeFrame(opcode, Buffer.from(JSON.stringify(payload), "utf8"));
	}

	/**
	 * Header and body go out as one buffer: Discord reads frames off the socket
	 * whole, and a header delivered without its payload stalls the connection.
	 */
	private writeFrame(opcode: number, body: Buffer): void {
		const socket = this.socket;
		if (!socket || socket.destroyed) return;
		const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
		frame.writeUInt32LE(opcode, 0);
		frame.writeUInt32LE(body.length, 4);
		body.copy(frame, HEADER_BYTES);
		socket.write(frame);
	}

	private clearTimer(name: "handshakeTimer" | "updateTimer"): void {
		const timer = this[name];
		if (!timer) return;
		clearTimeout(timer);
		this[name] = null;
	}
}

/**
 * Every socket a Discord client might be listening on, in the order they should
 * be tried. Several clients (stable, PTB, canary) can run at once, each taking
 * the next free index.
 */
function* socketPaths(): Generator<string> {
	if (process.platform === "win32") {
		for (let i = 0; i <= MAX_SOCKET_INDEX; i++) {
			yield `\\\\?\\pipe\\discord-ipc-${i}`;
		}
		return;
	}
	const base =
		process.env.XDG_RUNTIME_DIR ??
		process.env.TMPDIR ??
		process.env.TMP ??
		process.env.TEMP ??
		"/tmp";
	// Flatpak and snap builds nest their socket a directory deeper.
	const nests = ["", "app/com.discordapp.Discord/", "snap.discord/"];
	for (const nest of nests) {
		for (let i = 0; i <= MAX_SOCKET_INDEX; i++) {
			yield `${base}/${nest}discord-ipc-${i}`;
		}
	}
}

/** Resolves to a connected socket, or null if nothing is listening there. */
function openSocket(path: string): Promise<Socket | null> {
	return new Promise((resolve) => {
		const socket = connect(path);
		// A socket with no error listener throws process-wide, and one can arrive
		// at any point — including after this promise settles — so the swallow
		// stays attached for the socket's whole life.
		socket.on("error", () => {});
		socket.once("connect", () => resolve(socket));
		// Failing to connect emits "error" and then "close"; settling on the
		// latter covers both without needing to tell the causes apart.
		socket.once("close", () => resolve(null));
	});
}

/**
 * Whether Discord's media proxy stands any chance of reaching this origin.
 * Loopback, the private IPv4 ranges, link-local and unique-local IPv6, and
 * names that only a local resolver knows (`.local`, or no dot at all) are all
 * addressable from the user's machine but not from Discord's servers.
 */
function isPubliclyRoutable(baseUrl: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname;
	} catch {
		return false;
	}
	// URL keeps IPv6 literals wrapped in brackets.
	const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

	if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
		const [a, b] = host.split(".").map(Number);
		if (a === 0 || a === 10 || a === 127) return false;
		if (a === 169 && b === 254) return false; // link-local
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && b === 168) return false;
		if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
		return a < 224; // multicast and reserved
	}

	if (host.includes(":")) {
		const address = host.toLowerCase();
		if (address === "::1" || address === "::") return false;
		if (/^fe[89ab]/.test(address)) return false; // link-local fe80::/10
		if (/^f[cd]/.test(address)) return false; // unique-local fc00::/7
		return true;
	}

	const name = host.toLowerCase();
	if (name === "localhost" || name.endsWith(".localhost")) return false;
	if (/\.(local|internal|lan|home|home\.arpa)$/.test(name)) return false;
	// A single-label name resolves only through the local network's own DNS.
	return name.includes(".");
}

/**
 * Fits a title or artist into what Discord accepts. Over the limit it is cut
 * short; under it — a one-character track title — it is padded, because a field
 * that breaks the bounds fails the whole activity rather than just itself.
 */
function clampText(value: string): string {
	const text = value.trim();
	if (text.length < MIN_TEXT_LENGTH) return text.padEnd(MIN_TEXT_LENGTH, " ");
	if (text.length <= MAX_TEXT_LENGTH) return text;
	return `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}
