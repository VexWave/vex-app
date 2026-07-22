import { existsSync } from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import type { BrowserWindow } from "electrobun/bun";

/**
 * Windows-only native window polish, applied over Electrobun's window because
 * it exposes neither of these:
 *
 * - the title bar is drawn by the OS in the *system* theme, so it comes up
 *   white next to an app that is always dark. DWM lets us flip it per-window.
 * - the title bar / taskbar icon comes from the window, not the executable.
 *   Electrobun's build step is supposed to embed the icon into bun.exe with
 *   rcedit and that step is broken on their Windows CI ("Cannot find module
 *   'rcedit'"), so the window is left with CEF's default icon even when the
 *   exe itself has one. We set it on the window directly from the .ico that
 *   the build does copy into the bundle.
 *
 * Everything here is best-effort: a failure logs and leaves the stock chrome.
 */

// --- Win32 constants ---

const WM_SETICON = 0x0080;
const ICON_SMALL = 0;
const ICON_BIG = 1;
const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x0010;

/** Dark title bar. 20 since Win10 20H1; 19 was the pre-release attribute. */
const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
const DWMWA_USE_IMMERSIVE_DARK_MODE_PRE_20H1 = 19;
/** Explicit caption colours — Windows 11 (build 22000) and up. */
const DWMWA_BORDER_COLOR = 34;
const DWMWA_CAPTION_COLOR = 35;
const DWMWA_TEXT_COLOR = 36;

/**
 * COLORREF is 0x00BBGGRR. These mirror the dark theme in index.css — `--card`
 * for the caption so it continues the app header, `--border` and
 * `--foreground` for the frame and title text. The palette is neutral grey,
 * so the byte order doesn't matter for these values.
 */
const CAPTION_COLOR = 0x0f0f0f; // --card:       0 0% 5.9%
const BORDER_COLOR = 0x262626; // --border:     0 0% 14.9%
const TEXT_COLOR = 0xfafafa; // --foreground: 0 0% 98%

/** A null-terminated UTF-16 string, the encoding every *W* entry point wants. */
function wide(value: string): Buffer {
	return Buffer.from(`${value}\0`, "utf16le");
}

const user32 = () =>
	dlopen("user32.dll", {
		IsWindow: { args: [FFIType.ptr], returns: FFIType.bool },
		FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		// WPARAM/LPARAM are pointer-sized, so `ptr` is the portable declaration
		// for both the icon type and the HICON itself.
		SendMessageW: {
			args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
			returns: FFIType.ptr,
		},
		LoadImageW: {
			args: [
				FFIType.ptr,
				FFIType.ptr,
				FFIType.u32,
				FFIType.i32,
				FFIType.i32,
				FFIType.u32,
			],
			returns: FFIType.ptr,
		},
	});

const dwmapi = () =>
	dlopen("dwmapi.dll", {
		DwmSetWindowAttribute: {
			args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
			returns: FFIType.i32,
		},
	});

/**
 * The window's HWND. Electrobun's `ptr` is the native window handle on
 * Windows, but that's an implementation detail of its native wrapper — so it
 * is validated with IsWindow, and a lookup by title covers it changing.
 */
function resolveHwnd(
	window: BrowserWindow,
	title: string,
	lib: ReturnType<typeof user32>,
): Pointer | null {
	const candidate = window.ptr;
	if (candidate && lib.symbols.IsWindow(candidate)) return candidate;
	const found = lib.symbols.FindWindowW(null, ptr(wide(title)));
	return found && lib.symbols.IsWindow(found) ? found : null;
}

/** Sets a DWORD-valued DWM attribute. Returns true on S_OK. */
function setDwmDword(
	lib: ReturnType<typeof dwmapi>,
	hwnd: Pointer,
	attribute: number,
	value: number,
): boolean {
	const buffer = new Int32Array([value]);
	return (
		lib.symbols.DwmSetWindowAttribute(hwnd, attribute, ptr(buffer), 4) === 0
	);
}

/**
 * The bundled copy of the configured `win.icon`. Electrobun writes it next to
 * the app resources as `app.ico`; the process runs out of the sibling `bin`
 * directory (that's where its own native wrapper DLL is loaded from).
 */
function findIconFile(): string | null {
	const candidates = [
		join(process.cwd(), "..", "Resources", "app.ico"),
		join(process.cwd(), "Resources", "app.ico"),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Loads one size out of an .ico file. */
function loadIcon(
	lib: ReturnType<typeof user32>,
	file: string,
	size: number,
): Pointer | null {
	return (
		lib.symbols.LoadImageW(
			null,
			ptr(wide(file)),
			IMAGE_ICON,
			size,
			size,
			LR_LOADFROMFILE,
		) || null
	);
}

/**
 * Darkens the title bar and gives the window its app icon. No-op off Windows.
 * Call it after the window exists; the caption repaints on the next frame
 * change (the DPI resize nudge in index.ts is one).
 */
export function applyWindowChrome(window: BrowserWindow, title: string): void {
	if (process.platform !== "win32") return;

	try {
		const lib = user32();
		const hwnd = resolveHwnd(window, title, lib);
		if (!hwnd) {
			console.warn("Window chrome: no HWND for the main window, skipping.");
			return;
		}

		const dwm = dwmapi();
		// Pre-20H1 builds use the older attribute id; on newer ones it's a no-op
		// error, so only fall back when the current id is rejected.
		if (
			!setDwmDword(dwm, hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 1) &&
			!setDwmDword(dwm, hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE_PRE_20H1, 1)
		) {
			console.warn("Window chrome: dark title bar not supported here.");
		}
		// Windows 11 only — these fail harmlessly on 10, which keeps the plain
		// dark caption from the attribute above.
		setDwmDword(dwm, hwnd, DWMWA_CAPTION_COLOR, CAPTION_COLOR);
		setDwmDword(dwm, hwnd, DWMWA_BORDER_COLOR, BORDER_COLOR);
		setDwmDword(dwm, hwnd, DWMWA_TEXT_COLOR, TEXT_COLOR);

		const iconFile = findIconFile();
		if (!iconFile) {
			console.warn("Window chrome: no app.ico in the bundle, icon unchanged.");
			return;
		}
		// Both sizes: the small one is the title bar, the big one the taskbar
		// button and Alt+Tab. The icons are owned by the window for the rest of
		// the process's life, so they're never destroyed.
		const small = loadIcon(lib, iconFile, 16);
		const big = loadIcon(lib, iconFile, 32);
		if (small) lib.symbols.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, small);
		if (big) lib.symbols.SendMessageW(hwnd, WM_SETICON, ICON_BIG, big);
		if (!small && !big) {
			console.warn(`Window chrome: failed to load icon from ${iconFile}`);
		}
	} catch (err) {
		console.warn("Window chrome: skipped —", err);
	}
}
