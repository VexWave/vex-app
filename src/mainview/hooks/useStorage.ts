import { useSyncExternalStore } from "react";
import { storageService } from "@/api/StorageService";
import type { StorageService, StorageState } from "@/api/StorageService";

export function useStorage(): {
	storage: StorageState;
	service: StorageService;
} {
	const storage = useSyncExternalStore(
		storageService.subscribe,
		storageService.getSnapshot,
	);
	return { storage, service: storageService };
}
