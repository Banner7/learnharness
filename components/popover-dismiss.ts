import { useEffect, type RefObject } from "react";

/** Close a floating panel when a pointer lands outside its root. */
export function usePopoverDismiss(
	rootRef: RefObject<HTMLElement | null>,
	open: boolean,
	close: () => void,
): void {
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [open, close, rootRef]);
}
