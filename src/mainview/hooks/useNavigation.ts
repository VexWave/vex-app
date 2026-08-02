import { useSyncExternalStore } from "react";
import { navigationService, sectionOf } from "@/api/NavigationService";
import type {
	MainView,
	NavigationService,
	SectionName,
} from "@/api/NavigationService";

/**
 * Where the app is: the view the main area shows, and the section that view
 * belongs to. The switch and the window's chrome key off the section rather than
 * the view, so it is derived here once instead of at each of them.
 */
export function useNavigation(): {
	view: MainView;
	section: SectionName;
	service: NavigationService;
} {
	const view = useSyncExternalStore(
		navigationService.subscribe,
		navigationService.getSnapshot,
	);
	return { view, section: sectionOf(view), service: navigationService };
}
