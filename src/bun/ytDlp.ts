import path from "node:path";

/**
 * Plumbing shared by the callers that spawn the managed yt-dlp — the URL
 * importer and the Discover search: the arguments every run must carry, the
 * child environment it needs to find its helper binaries, the reading of its
 * printed fields, and the account of why it failed.
 */

/**
 * Arguments every yt-dlp run passes. `--encoding UTF-8` is the one that matters:
 * without it Windows encodes `--print` output in the console codepage and
 * mangles accents in titles and creator names. It lives here rather than in each
 * argument list so a new caller can't forget it — yt-dlp's own flag is the only
 * one that works, since the binary is frozen and ignores PYTHONIOENCODING.
 */
export const YT_DLP_BASE_ARGS = ["--encoding", "UTF-8"] as const;

/**
 * Child env with the managed bin dir prepended to PATH. yt-dlp discovers deno
 * (and ffprobe) by scanning PATH. The existing key must be overwritten in place:
 * a GUI-launched app inherits "Path", and spreading plus a new "PATH" key would
 * put BOTH in the child's block — with the original (bin-dir-less) one winning
 * the %PATH% lookup.
 */
export function childEnv(binDir: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	const pathKey =
		Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	env[pathKey] = binDir + path.delimiter + (env[pathKey] ?? "");
	return env;
}

/**
 * Reads a yt-dlp run that prints its whole answer at once, under a timeout.
 *
 * Two orderings in here are load-bearing and easy to get wrong separately in
 * each caller: stdout is drained *before* awaiting exit, because a child that
 * fills its pipe blocks forever while nothing reads it, and the timer is cleared
 * in `finally`, so a fast run doesn't leave a kill armed for the next one. The
 * caller keeps the handle it spawned — it may need to kill the run for its own
 * reasons — so the timeout reports rather than throws.
 */
export async function readYtDlpOutput(
	proc: { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill: () => void },
	timeoutMs: number,
): Promise<{ stdout: string; timedOut: boolean }> {
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	try {
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		return { stdout, timedOut };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * A positive whole number out of a field yt-dlp may report as "NA", as nothing
 * at all, or as a float — durations and byte counts both arrive that way, the
 * first parsed from JSON and the second printed as text.
 */
export function ytDlpNumber(raw: string | number | undefined): number | undefined {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

/** Trim a printed field, mapping yt-dlp's "NA" / empty to undefined. */
export function cleanField(raw: string): string | undefined {
	const value = raw.trim();
	return value && value !== "NA" ? value : undefined;
}

/**
 * Like cleanField, but also drops YouTube's auto-generated " - Topic" suffix on
 * artist channel names so the proposed artist matches how they're stored.
 */
export function cleanArtistName(raw: string | undefined): string | undefined {
	return cleanField(raw ?? "")?.replace(/\s*-\s*Topic$/i, "").trim() || undefined;
}

/** Keeps only a bounded tail of a child's stderr for its failure message. */
export function collectStderr(stderr: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stderr).text().then(
		(text) => text.slice(-4000),
		() => "",
	);
}

/** The most specific reason a yt-dlp run failed that its stderr gives away. */
export async function describeYtDlpFailure(
	exitCode: number | null,
	stderrTail: Promise<string>,
): Promise<string> {
	const lines = (await stderrTail).split(/\r?\n/).reverse();
	// yt-dlp prefixes its own failures with "ERROR:"; the last one is the cause.
	const errorLine = lines.find((line) => line.startsWith("ERROR:"));
	if (errorLine) return errorLine.replace(/^ERROR:\s*/, "");
	return (
		lines.find((line) => line.trim() !== "") ??
		`yt-dlp exited with code ${exitCode ?? "unknown"}`
	);
}

export async function* readLines(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? "";
		yield* lines;
	}
	if (buffer) yield buffer;
}
