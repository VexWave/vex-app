// Stamps the Windows app icon onto an exe. electrobun does this itself — for the
// bundle's launcher.exe and bun.exe, and for the installer stub — but its CLI
// ships as a bun-compiled binary where the `require.resolve("rcedit")` behind
// that step cannot see this checkout's node_modules, and the try/catch around it
// swallows the failure, so every exe would ship with the default icon.
//
// Run directly this is electrobun's postBuild hook, which catches the bundle at
// the one moment its exes are loose files: after the bundle is assembled, before
// electrobun tars it. fuse-installer.ts imports stampWinIcon for the stub.
import { join } from "node:path";
import rcedit from "rcedit";

// Mirrors electrobun.config.ts's build.win.icon: importing the config would drag
// electrobun's DOM-typed API graph into these bun-only scripts, the same reason
// src/shared/limits.ts mirrors the contract's bounds instead of importing them.
const icon = join(import.meta.dir, "..", "assets", "vex-logo.ico");

export const stampWinIcon = (exe: string) => rcedit(exe, { icon });

if (import.meta.main && process.env.ELECTROBUN_OS === "win") {
	// electrobun hands every hook the build dir and the bundle's folder name; on
	// Windows it lays that bundle out as <name>/bin/.
	const { ELECTROBUN_BUILD_DIR: buildDir, ELECTROBUN_APP_NAME: name } =
		process.env;
	if (!buildDir || !name) {
		throw new Error("postBuild hook: no build dir or app name in the env.");
	}
	// launcher.exe is the shortcut target and bun.exe owns the window and its
	// taskbar entry. The CEF helpers never surface, so they keep the default.
	for (const exe of ["launcher.exe", "bun.exe"]) {
		await stampWinIcon(join(buildDir, name, "bin", exe));
	}
}
