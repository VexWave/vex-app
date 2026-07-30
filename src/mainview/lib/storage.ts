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

const booleanValue = (key: string): StoredValue<boolean> =>
	new StoredValue(key, String, (raw) => raw === "true");

const numberValue = (
	key: string,
	isValid: (value: number) => boolean = () => true,
): StoredValue<number> =>
	new StoredValue(key, String, (raw) => {
		const value = Number(raw);
		return Number.isFinite(value) && isValid(value) ? value : null;
	});

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
		host: stringValue("player.server.host"),
		port: stringValue("player.server.port"),
		token: stringValue("player.server.token"),
	},
	player: {
		volume: numberValue("player.volume", (v) => v >= 0 && v <= 1),
		muted: booleanValue("player.muted"),
		repeat: enumValue<RepeatMode>("player.repeat", ["off", "all", "one"]),
	},
	discover: {
		/** The platform the Discover view searches. */
		source: enumValue<SearchSource>("discover.source", [
			"youtube",
			"soundcloud",
		]),
	},
} as const;
