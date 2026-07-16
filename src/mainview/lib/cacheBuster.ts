/**
 * Per-key cache-busting version registry.
 *
 * Some resources are served from a URL that never changes — e.g. a stream-proxy
 * cover or avatar URL, keyed by the resource's stable id — yet whose bytes can
 * be replaced on the server. Chromium would keep serving the stale cached copy
 * because the URL is identical and the proxy forwards no cache headers. Bumping
 * a per-key version and appending it as a query param forces a re-fetch.
 *
 * Keys are arbitrary stable identifiers (a track queue id, an artist id, …).
 * Give each independent resource kind its own instance, or namespace the keys,
 * so versions can't collide across kinds.
 */
export class CacheBuster {
	private versions = new Map<string, number>();

	/** Bump the version for `key`, so the next `apply` yields a fresh URL. */
	bump(key: string): void {
		this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
	}

	/**
	 * Append the current version for `key` as a `v=` query param. Returns the URL
	 * unchanged when it was never bumped (and passes through empty/undefined URLs
	 * so callers can pipe optional URLs straight through). Uses `&` when the URL
	 * already carries a query string.
	 */
	apply(key: string, url: string | undefined): string | undefined {
		if (!url) return url;
		const version = this.versions.get(key);
		if (!version) return url;
		return `${url}${url.includes("?") ? "&" : "?"}v=${version}`;
	}

	/** Forget all versions (e.g. on logout, when URLs are session-scoped). */
	clear(): void {
		this.versions.clear();
	}
}
