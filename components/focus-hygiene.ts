"use client";

/**
 * Pointer activation of a transient transcript control releases focus
 * rather than leaving the tapped button selected. Keyboard activation is
 * unaffected so native focus remains usable.
 */
export function blurAfterPointerClick(e: {
	detail: number;
	currentTarget: EventTarget | null;
}): void {
	if (e.detail === 0) return;
	const el = e.currentTarget as { blur?: unknown } | null;
	if (el && typeof el.blur === "function") (el.blur as () => void).call(el);
}
