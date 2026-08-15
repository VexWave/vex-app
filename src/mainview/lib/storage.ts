import { EQ_BANDS, EQ_GAIN_LIMIT_DB } from "@/player/Equalizer";
import type { SearchSource } from "../../shared/rpcSchema";
import type { RepeatMode } from "@/player/types";

/**
 * A single typed value persisted under one localStorage key.
 *
 * Serialisation and validation live next to the key they belong to, so
 * consumers read and write domain values — a number, a boolean, an enum —
 * instead of juggling raw strings and re-checking bounds at every call site.
 * `get` returns null when the key is unset or its stored string fails
 * validation, letting callers fall back to their own default.
 */
class StoredValue<T> {
	constructor(
		private readonly key: string,
		private readonly encode: (value: T) => string,
		private readonly decode: (raw: string) => T | null,
	) {}

	get(): T | null {
		const raw = localStorage.getItem(this.key);
		return raw === null ? null : this.decode(raw);
	}

	set(value: T): void {
		localStorage.setItem(this.key, this.encode(value));
	}

	remove(): void {
		localStorage.removeItem(this.key);
	}
}

const stringValue = (key: string): StoredValue<string> =>
	new StoredValue(
		key,
		(value) => value,
		(raw) => raw,
	);

// Decodes only the two strings it encodes, so that a setting which defaults to
// *on* can tell an explicit "off" from a key that was never written.
const booleanValue = (key: string): StoredValue<boolean> =>
	new StoredValue(key, String, (raw) =>
		raw === "true" || raw === "false" ? raw === "true" : null,
	);

const numberValue = (
	key: string,
	isValid: (value: number) => boolean = () => true,
): StoredValue<number> =>
	new StoredValue(key, String, (raw) => {
		const value = Number(raw);
		return Number.isFinite(value) && isValid(value) ? value : null;
	});

/**
 * A fixed-length list of numbers. Validated as a whole — one bad entry or the
 * wrong count decodes to null rather than to a partly restored list — because
 * the entries are positional: what a number belongs to is its index and nothing
 * else, so a list of unexpected length cannot be read at all.
 */
const numberListValue = (
	key: string,
	length: number,
	isValid: (value: number) => boolean = () => true,
): StoredValue<readonly number[]> =>
	new StoredValue(
		key,
		(value) => value.join(","),
		(raw) => {
			const values = raw.split(",").map(Number);
			return values.length === length &&
				values.every((value) => Number.isFinite(value) && isValid(value))
				? values
				: null;
		},
	);

const enumValue = <T extends string>(
	key: string,
	allowed: readonly T[],
): StoredValue<T> =>
	new StoredValue(
		key,
		(value) => value,
		(raw) => (allowed.includes(raw as T) ? (raw as T) : null),
	);

/**
 * The app's persisted settings, centralised so every localStorage key is
 * declared in exactly one place and can't silently collide. Only user
 * preferences and the session are stored here — never the password.
 */
export const storage = {
	session: {
		/** Base URL of the server, normalized by `parseServerUrl`. */
		url: stringValue("player.server.url"),
		token: stringValue("player.server.token"),
	},
	player: {
		volume: numberValue("player.volume", (v) => v >= 0 && v <= 1),
		muted: booleanValue("player.muted"),
		repeat: enumValue<RepeatMode>("player.repeat", ["off", "all", "one"]),
		shuffle: booleanValue("player.shuffle"),
	},
	equalizer: {
		/**
		 * Whether the bands are applied or bypassed. Unset means on — which is
		 * what `booleanValue` has to tell apart from a stored "false".
		 */
		enabled: booleanValue("equalizer.enabled"),
		/** One gain in dB per band, in `EQ_BANDS` order. */
		gains: numberListValue(
			"equalizer.gains",
			EQ_BANDS.length,
			(value) => Math.abs(value) <= EQ_GAIN_LIMIT_DB,
		),
	},
	discord: {
		/** Whether the Rich Presence runs at all. Unset means on. */
		presenceEnabled: booleanValue("discord.presenceEnabled"),
	},
	discover: {
		/** The platform the Discover view searches. */
		source: enumValue<SearchSource>("discover.source", [
			"youtube",
			"soundcloud",
		]),
	},
} as const;
