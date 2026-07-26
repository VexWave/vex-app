/**
 * Open a track row's context menu from a left-click on its kebab button:
 * Radix's ContextMenuTrigger listens for `contextmenu`, so we synthesize one
 * anchored at the button. Native right-click on the row keeps working
 * unchanged.
 */
export function openRowMenu(button: HTMLElement) {
	const rect = button.getBoundingClientRect();
	button.dispatchEvent(
		new MouseEvent("contextmenu", {
			bubbles: true,
			clientX: rect.left + rect.width / 2,
			clientY: rect.bottom,
		}),
	);
}
