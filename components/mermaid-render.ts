/**
 * The app's ONE mermaid renderer (the chrome-melt wave, 2026-09-19): both the
 * in-chat block (components/md-blocks.tsx) and the session-scoped focus
 * overlay (components/session-overlay.tsx) render charts through this module
 * — one config, one plugin instance, unique render ids.
 * App-owned rendering keeps the inline chart and focus overlay consistent
 * instead of using Streamdown's built-in fullscreen portal.
 */

import { createMermaidPlugin } from "@streamdown/mermaid";
import type { MermaidConfig } from "mermaid";

/** The chart's base font size (px) — mermaid sizes ALL text relative to
 *  this, so it's the number the display-width cap (md-blocks) divides by:
 *  a chart shown at its natural width renders text at exactly this size.
 *  Pinned explicitly so a mermaid default change can't silently shift the
 *  cap (owner rule, chrome-melt tweaks wave, 2026-09-19: chart text must
 *  never render larger than the session's own text). */
export const MERMAID_FONT_SIZE = 16;

// Redesign (owner, 2026-10-27): the app has light and dark modes, so the
// mermaid theme is read from <html class="dark"> at each render — "dark" for
// Slate, and "base" tinted to the parchment palette for light (mermaid's grey
// "neutral" looked cold on yellow paper). Open charts redraw on a theme flip
// (useIsDarkTheme in lib/theme-mode.ts).
function mermaidConfig(): MermaidConfig {
	const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
	return {
		fontFamily: "ui-sans-serif, system-ui, sans-serif",
		fontSize: MERMAID_FONT_SIZE,
		securityLevel: "strict",
		...(dark
			? { theme: "dark" as const }
			: {
					theme: "base" as const,
					themeVariables: {
						background: "#e5d8be",
						primaryColor: "#efe6d3",
						primaryTextColor: "#3a322d",
						primaryBorderColor: "#a89984",
						secondaryColor: "#d6c8ad",
						tertiaryColor: "#e5d8be",
						lineColor: "#5c5047",
						textColor: "#3a322d",
					},
				}),
	};
}

const plugin = createMermaidPlugin();

/** Render one chart source to an svg string. The id is unique per call —
 *  mermaid caches rendered ids, and a repeated id across charts/renders
 *  returns the stale svg (the bug streamdown's own id minting avoids). */
export async function renderMermaid(chart: string): Promise<string> {
	const id = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const { svg } = await plugin.getMermaid(mermaidConfig()).render(id, chart);
	return svg;
}
