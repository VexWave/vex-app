import { existsSync } from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import type { BrowserWindow } from "electrobun/bun";

const WM_SETICON = 0x0080;
const ICON_SMALL = 0;
const ICON_BIG = 1;
const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x0010;

// Dark mode is 20 since Win10 20H1, 19 before; the caption colours are Win11
// (22000) up.
const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
const DWMWA_USE_IMMERSIVE_DARK_MODE_PRE_20H1 = 19;
const DWMWA_BORDER_COLOR = 34;
const DWMWA_CAPTION_COLOR = 35;
const DWMWA_TEXT_COLOR = 36;

// COLORREF is 0x00BBGGRR. Mirrors --card, --border and --foreground in
// index.css.
const CAPTION_COLOR = 0x0f0f0f;
const BORDER_COLOR = 0x262626;
const TEXT_COLOR = 0xfafafa;

function wide(value: string): Buffer {
	return Buffer.from(`${value}\0`, "utf16le");
}

const user32 = () =>
	dlopen("user32.dll", {
		IsWindow: { args: [FFIType.ptr], returns: FFIType.bool },
		FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
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

function findIconFile(): string | null {
	const candidates = [
		join(process.cwd(), "..", "Resources", "app.ico"),
		join(process.cwd(), "Resources", "app.ico"),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

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
		if (
			!setDwmDword(dwm, hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 1) &&
			!setDwmDword(dwm, hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE_PRE_20H1, 1)
		) {
			console.warn("Window chrome: dark title bar not supported here.");
		}
		setDwmDword(dwm, hwnd, DWMWA_CAPTION_COLOR, CAPTION_COLOR);
		setDwmDword(dwm, hwnd, DWMWA_BORDER_COLOR, BORDER_COLOR);
		setDwmDword(dwm, hwnd, DWMWA_TEXT_COLOR, TEXT_COLOR);

		// Electrobun's rcedit step for embedding the exe icon fails on its Windows
		// CI, so the icon goes on the window here instead.
		const iconFile = findIconFile();
		if (!iconFile) {
			console.warn("Window chrome: no app.ico in the bundle, icon unchanged.");
			return;
		}
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
