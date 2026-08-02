import { Compass, LibraryBig } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import type { ComponentType, ReactNode } from "react";
import type { SectionName } from "@/api/NavigationService";

/**
 * How each of the app's sides presents itself: the name and glyph its segment of
 * the switch wears, and the chrome it brings with it — in one table, so how a
 * section looks is settled in one place. (Which views it holds is the other half,
 * and that is `NavigationService`'s.)
 *
 * `Aside` is the panel standing beside the main area for as long as that section
 * is the one showing. A section that navigates within itself brings one; a
 * section with nowhere to go declares none and takes the whole window, which is
 * only safe because the switch it was reached from never leaves the app bar.
 * Since a section can drop its aside, **nothing the whole app depends on may live
 * in one** — that is why logging out is in the app bar.
 *
 * `Record<SectionName, …>`, so a section added to the navigation has to say how
 * it looks before the app will build.
 */
export const SECTIONS: Record<
	SectionName,
	{
		label: string;
		Icon: (props: { className?: string }) => ReactNode;
		Aside?: ComponentType;
	}
> = {
	library: { label: "Library", Icon: LibraryBig, Aside: Sidebar },
	discover: { label: "Discover", Icon: Compass },
};

/**
 * The sections in the order the switch lays them out. Derived from the table's
 * keys so one can't be added to it and still be missing from the UI — the failure
 * the compiler cannot catch on a hand-written list.
 */
export const SECTION_ORDER = Object.keys(SECTIONS) as SectionName[];
