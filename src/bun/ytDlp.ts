import path from "node:path";

// Without --encoding UTF-8, Windows encodes --print output in the console
// codepage and mangles accents. The frozen binary ignores PYTHONIOENCODING, so
// yt-dlp's own flag is the only one that works.
export const YT_DLP_BASE_ARGS = ["--encoding", "UTF-8"] as const;

// yt-dlp finds deno and ffprobe by scanning PATH. The existing key is
// overwritten in place: a GUI-launched app inherits "Path", and adding "PATH"
// beside it would leave the bin-dir-less one winning the lookup.
export function childEnv(
	binDir: string,
	proxy?: string,
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	const pathKey =
		Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	env[pathKey] = binDir + path.delimiter + (env[pathKey] ?? "");
	if (proxy) {
		// no_proxy stays: Bun's fetch honours it even with an explicit proxy.
		for (const key of Object.keys(env)) {
			if (/^(https?|all)_proxy$/i.test(key)) delete env[key];
		}
		env.http_proxy = proxy;
		env.https_proxy = proxy;
	}
	return env;
}

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

export function ytDlpNumber(raw: string | number | undefined): number | undefined {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

export function cleanField(raw: string): string | undefined {
	const value = raw.trim();
	return value && value !== "NA" ? value : undefined;
}

export function cleanArtistName(raw: string | undefined): string | undefined {
	return cleanField(raw ?? "")?.replace(/\s*-\s*Topic$/i, "").trim() || undefined;
}

export function collectStderr(stderr: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stderr).text().then(
		(text) => text.slice(-4000),
		() => "",
	);
}

export async function describeYtDlpFailure(
	exitCode: number | null,
	stderrTail: Promise<string>,
): Promise<string> {
	const lines = (await stderrTail).split(/\r?\n/).reverse();
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
