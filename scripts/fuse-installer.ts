// Fuses electrobun's Windows installer set into a single self-contained exe.
// Run after `electrobun build`: bun run scripts/fuse-installer.ts <stable|canary>
//
// The CLI leaves three files that only work together: a ~0.4 MB extractor stub,
// the app archive, and the metadata naming what to install where. The extractor
// looks for the archive beside itself, so shipping it means shipping a folder —
// which is why the CLI wraps them in a zip, and why a download ends up nested.
//
// The same extractor also reads a payload appended to its own bytes, the mode
// electrobun's Linux installer uses, and falls back to it whenever the sibling
// files are absent. Appending the set here produces one executable that needs
// nothing beside it.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";

// Both markers must match the extractor's own (package/src/extractor/main.zig).
// It scans itself for the *second* metadata marker: the first is this literal
// sitting in its string table.
const METADATA_MARKER = "ELECTROBUN_METADATA_V1";
const ARCHIVE_MARKER = "ELECTROBUN_ARCHIVE_V1";

const CHANNELS = ["stable", "canary"] as const;

const channel = process.argv[2];
if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) {
	throw new Error(
		`Usage: bun run scripts/fuse-installer.ts <${CHANNELS.join("|")}>`,
	);
}

const buildFolder = `build/${channel}-win-x64`;

const setupExes = [...new Bun.Glob("*-Setup*.exe").scanSync(buildFolder)];
if (setupExes.length !== 1) {
	throw new Error(
		`Expected exactly one installer stub in ${buildFolder}, found ${setupExes.length}. ` +
			`Run \`bun run build:${channel}\` first.`,
	);
}

const stem = setupExes[0]!.replace(/\.exe$/, "");
const stubBytes = await Bun.file(`${buildFolder}/${stem}.exe`).bytes();
const metadataBytes = await Bun.file(
	`${buildFolder}/${stem}.metadata.json`,
).bytes();
const archive = Bun.file(`${buildFolder}/${stem}.tar.zst`);

// Not artifacts/: `electrobun build` deletes that folder wholesale on every run,
// so fusing into it would leave one channel's installer to be wiped by the next
// channel's build. The stems already differ, so both channels coexist here.
mkdirSync("installers", { recursive: true });
const outPath = `installers/${stem}.exe`;

// The sink writes from the start but does not truncate, so a rebuild whose
// archive compressed smaller would leave the previous exe's tail sitting past
// the new end. The extractor reads its payload to end-of-file, and those stale
// bytes trailing the zstd frame are what it reports as a MalformedFrame — after
// decompressing the whole archive, so it looks like a crash at the finish line.
rmSync(outPath, { force: true });

const sink = Bun.file(outPath).writer();
sink.write(stubBytes);
sink.write(Buffer.from(METADATA_MARKER, "utf8"));
sink.write(metadataBytes);
sink.write(Buffer.from(ARCHIVE_MARKER, "utf8"));

// The archive is the bulk of the app (~300 MB), so it is copied through in
// chunks rather than held in memory alongside everything else.
const digest = createHash("sha256");
let archiveSize = 0;
for await (const chunk of archive.stream()) {
	digest.update(chunk);
	archiveSize += chunk.byteLength;
	sink.write(chunk);
	await sink.flush();
}
await sink.end();

// Nothing downstream can tell a payload short or long by a few bytes from a
// good one until zstd chokes on it, at the end of a 300 MB install. Cheap to
// check here, where the number is still known exactly.
const expected =
	stubBytes.byteLength +
	METADATA_MARKER.length +
	metadataBytes.byteLength +
	ARCHIVE_MARKER.length +
	archiveSize;
const written = statSync(outPath).size;
if (written !== expected) {
	throw new Error(
		`${outPath} is ${written} bytes, expected ${expected}. The fused payload is not intact.`,
	);
}

const total = stubBytes.byteLength + archiveSize;
console.log(
	`Fused ${channel} installer: ${outPath} (${(total / 1024 / 1024).toFixed(2)} MB)`,
);
console.log(`  stub    ${(stubBytes.byteLength / 1024 / 1024).toFixed(2)} MB`);
console.log(`  archive ${(archiveSize / 1024 / 1024).toFixed(2)} MB`);
console.log(`  sha256  ${digest.digest("hex")} (archive)`);
