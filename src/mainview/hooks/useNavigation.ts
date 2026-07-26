import { useSyncExternalStore } from "react";
import { navigationService } from "@/api/NavigationService";
import type { MainView, NavigationService } from "@/api/NavigationService";

export function useNavigation(): {
	view: MainView;
	service: NavigationService;
} {
	const view = useSyncExternalStore(
		navigationService.subscribe,
		navigationService.getSnapshot,
	);
	return { view, service: navigationService };
}
