import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** 75 → "1:15"; 3675 → "1:01:15". Unknown/invalid durations → "–:––". */
export function formatTime(totalSeconds: number): string {
	if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "–:––";
	const seconds = Math.floor(totalSeconds % 60);
	const minutes = Math.floor((totalSeconds / 60) % 60);
	const hours = Math.floor(totalSeconds / 3600);
	const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
	const ss = String(seconds).padStart(2, "0");
	return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "12 results" / "1 result" — a count with its noun, pluralised by an "s". */
export function countLabel(count: number, noun: string): string {
	return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** "12 tracks" / "1 track" / "No tracks" — every collection's size line. */
export function trackCountLabel(count: number): string {
	return count === 0 ? "No tracks" : countLabel(count, "track");
}

/** 1_500_000 → "1.4 MB". */
export function formatMb(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Read a blob's bytes as a base64 string (without the `data:…;base64,` prefix).
 * FileReader avoids chunked btoa gymnastics for multi-MB blobs.
 */
export function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () =>
			reject(reader.error ?? new Error("Failed to read file data"));
		reader.onload = () => {
			const dataUrl = reader.result as string;
			resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
		};
		reader.readAsDataURL(blob);
	});
}
