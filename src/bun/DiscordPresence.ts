import { connect, type Socket } from "node:net";
import { trackImagePath } from "../../contract/contract";
import type {
	PresenceRefusal,
	PresenceStatus,
	PresenceTrack,
} from "../shared/rpcSchema";

// A real application id from https://discord.com/developers/applications: its
// name is what Discord prints as "Listening to ...", and its art assets are
// what the keys below resolve against. Not a secret, and a packaged build has
// no shell to override it from.
const APPLICATION_ID = "1533078418541908019";

const LOGO_ASSET = "vexwave";

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const HEADER_BYTES = 8;

const MAX_FRAME_BYTES = 1 << 20;

const MAX_SOCKET_INDEX = 9;

const ACTIVITY_LISTENING = 2;

const DEBOUNCE_MS = 1_000;

const MIN_UPDATE_INTERVAL_MS = 5_000;

const RECONNECT_INTERVAL_MS = 10_000;

const HANDSHAKE_TIMEOUT_MS = 5_000;

// Discord rejects details/state outside this length.
const MIN_TEXT_LENGTH = 2;
const MAX_TEXT_LENGTH = 128;

interface ActivityAssets {
	large_image?: string;
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
	private enabled = false;
	private sweeping = false;
	private socket: Socket | null = null;
	private inbox: Buffer = Buffer.alloc(0);
	private ready = false;
	private now: PresenceTrack | null = null;
	private shown = false;
	private pendingNonce: string | null = null;
	private refusal: PresenceRefusal | null = null;
	private lastReported: PresenceStatus | null = null;
	private lastSentAt = 0;
	private updateTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
	private loggedOffline = false;
	private loggedError = false;

	constructor(
		private readonly resolveBaseUrl: () => string | null,
		private readonly onStatus: (status: PresenceStatus) => void,
	) {}

	setEnabled(enabled: boolean): PresenceStatus {
		if (enabled !== this.enabled) {
			this.enabled = enabled;
			if (enabled) void this.sweep();
			else this.disconnect();
		}
		return this.status();
	}

	setNowPlaying(now: PresenceTrack | null): void {
		this.now = now;
		this.schedule();
	}

	private async sweep(): Promise<void> {
		if (this.sweeping) return;
		this.sweeping = true;
		try {
			for (const path of socketPaths()) {
				const socket = await openSocket(path);
				if (!this.enabled) {
					socket?.destroy();
					return;
				}
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
		} finally {
			this.sweeping = false;
		}
	}

	private scheduleSweep(): void {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.sweep();
		}, RECONNECT_INTERVAL_MS);
		this.reconnectTimer.unref?.();
	}

	private attach(socket: Socket): void {
		this.socket = socket;
		this.inbox = Buffer.alloc(0);
		this.ready = false;
		this.shown = false;
		this.pendingNonce = null;
		this.refusal = null;
		this.loggedError = false;
		this.lastReported = null;
		socket.on("data", (chunk: Buffer) => this.receive(chunk));
		socket.on("close", () => this.detach(socket));
		this.writeJson(OP_HANDSHAKE, { v: 1, client_id: APPLICATION_ID });
		this.handshakeTimer = setTimeout(() => {
			this.handshakeTimer = null;
			if (!this.ready) socket.destroy();
		}, HANDSHAKE_TIMEOUT_MS);
		this.handshakeTimer.unref?.();
	}

	private detach(socket: Socket): void {
		if (this.socket !== socket) return;
		const wasReady = this.ready;
		this.socket = null;
		this.ready = false;
		this.inbox = Buffer.alloc(0);
		this.clearTimer("handshakeTimer");
		this.clearTimer("updateTimer");
		if (wasReady) {
			this.reportStatus();
			console.log("Discord Rich Presence: Discord went away, reconnecting.");
			this.loggedOffline = true;
		}
		this.scheduleSweep();
	}

	private disconnect(): void {
		const socket = this.socket;
		this.socket = null;
		this.ready = false;
		this.now = null;
		this.pendingNonce = null;
		this.refusal = null;
		this.lastReported = null;
		this.clearTimer("reconnectTimer");
		this.clearTimer("handshakeTimer");
		this.clearTimer("updateTimer");
		socket?.destroy();
	}

	private receive(chunk: Buffer): void {
		this.inbox =
			this.inbox.length === 0 ? chunk : Buffer.concat([this.inbox, chunk]);
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
			this.writeFrame(OP_PONG, body);
			return;
		}
		if (opcode === OP_CLOSE) {
			this.socket?.destroy();
			return;
		}
		if (opcode !== OP_FRAME) return;

		let message: {
			evt?: string;
			nonce?: string;
			data?: Record<string, unknown>;
		};
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
			this.reportStatus();
			this.schedule();
			return;
		}

		if (!message.nonce || message.nonce !== this.pendingNonce) return;
		this.pendingNonce = null;

		if (message.evt === "ERROR") {
			const { code, message: text } = (message.data ?? {}) as PresenceRefusal;
			this.refusal = { code, message: text };
			if (!this.loggedError) {
				this.loggedError = true;
				console.warn(
					`Discord Rich Presence: Discord rejected the update (${code ?? "?"}: ${text ?? "no detail"}).`,
				);
			}
		} else {
			this.refusal = null;
		}
		this.reportStatus();
	}

	private schedule(): void {
		if (!this.ready) return;
		if (this.updateTimer) clearTimeout(this.updateTimer);
		const owed = MIN_UPDATE_INTERVAL_MS - (Date.now() - this.lastSentAt);
		this.updateTimer = setTimeout(
			() => {
				this.updateTimer = null;
				this.publish();
			},
			Math.max(DEBOUNCE_MS, owed),
		);
		this.updateTimer.unref?.();
	}

	private publish(): void {
		if (!this.ready) return;
		const now = this.now;
		if (!now && !this.shown) return;
		this.lastSentAt = Date.now();
		this.shown = now !== null;
		const nonce = crypto.randomUUID();
		this.pendingNonce = nonce;
		this.writeJson(OP_FRAME, {
			cmd: "SET_ACTIVITY",
			args: {
				pid: process.pid,
				activity: now ? this.buildActivity(now) : undefined,
			},
			nonce,
		});
	}

	private buildActivity(now: PresenceTrack): Activity {
		const cover = this.coverUrl(now);
		const start = Date.now() - Math.round(now.positionSec * 1000);
		return {
			type: ACTIVITY_LISTENING,
			details: clampText(now.title),
			state: now.artist ? clampText(now.artist) : undefined,
			timestamps:
				now.durationSec > 0
					? { start, end: start + Math.round(now.durationSec * 1000) }
					: { start },
			assets: {
				large_image: cover ?? LOGO_ASSET,
				small_image: cover ? LOGO_ASSET : undefined,
				small_text: cover ? "VexWave" : undefined,
			},
		};
	}

	private coverUrl(now: PresenceTrack): string | undefined {
		if (!now.hasCover) return undefined;
		const baseUrl = this.resolveBaseUrl();
		if (!baseUrl || !isPubliclyRoutable(baseUrl)) return undefined;
		return baseUrl + trackImagePath(now.id);
	}

	private writeJson(opcode: number, payload: unknown): void {
		this.writeFrame(opcode, Buffer.from(JSON.stringify(payload), "utf8"));
	}

	// Header and body go out as one buffer: Discord reads frames whole, and a
	// header delivered without its payload stalls the connection.
	private writeFrame(opcode: number, body: Buffer): void {
		const socket = this.socket;
		if (!socket || socket.destroyed) return;
		const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
		frame.writeUInt32LE(opcode, 0);
		frame.writeUInt32LE(body.length, 4);
		body.copy(frame, HEADER_BYTES);
		socket.write(frame);
	}

	private status(): PresenceStatus {
		if (!this.ready) return { connection: "offline" };
		if (this.refusal) return { connection: "refused", refusal: this.refusal };
		return { connection: "connected" };
	}

	private reportStatus(): void {
		const status = this.status();
		if (
			this.lastReported &&
			this.lastReported.connection === status.connection &&
			this.lastReported.refusal?.code === status.refusal?.code &&
			this.lastReported.refusal?.message === status.refusal?.message
		) {
			return;
		}
		this.lastReported = status;
		this.onStatus(status);
	}

	private clearTimer(
		name: "handshakeTimer" | "updateTimer" | "reconnectTimer",
	): void {
		const timer = this[name];
		if (!timer) return;
		clearTimeout(timer);
		this[name] = null;
	}
}

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
	const nests = ["", "app/com.discordapp.Discord/", "snap.discord/"];
	for (const nest of nests) {
		for (let i = 0; i <= MAX_SOCKET_INDEX; i++) {
			yield `${base}/${nest}discord-ipc-${i}`;
		}
	}
}

function openSocket(path: string): Promise<Socket | null> {
	return new Promise((resolve) => {
		const socket = connect(path);
		socket.on("error", () => {});
		socket.once("connect", () => resolve(socket));
		socket.once("close", () => resolve(null));
	});
}

function isPubliclyRoutable(baseUrl: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname;
	} catch {
		return false;
	}
	const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

	if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
		const [a, b] = host.split(".").map(Number);
		if (a === 0 || a === 10 || a === 127) return false;
		if (a === 169 && b === 254) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && b === 168) return false;
		if (a === 100 && b >= 64 && b <= 127) return false;
		return a < 224;
	}

	if (host.includes(":")) {
		const address = host.toLowerCase();
		if (address === "::1" || address === "::") return false;
		if (/^fe[89ab]/.test(address)) return false;
		if (/^f[cd]/.test(address)) return false;
		return true;
	}

	const name = host.toLowerCase();
	if (name === "localhost" || name.endsWith(".localhost")) return false;
	if (/\.(local|internal|lan|home|home\.arpa)$/.test(name)) return false;
	return name.includes(".");
}

function clampText(value: string): string {
	const text = value.trim();
	if (text.length < MIN_TEXT_LENGTH) return text.padEnd(MIN_TEXT_LENGTH, " ");
	if (text.length <= MAX_TEXT_LENGTH) return text;
	return `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}
