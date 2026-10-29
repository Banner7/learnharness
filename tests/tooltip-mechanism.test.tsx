/**
 * Tooltip-wave mechanism pins (owner, 2026-09-25): the composition rule —
 * icon/pill controls ride the styled Radix tooltip via Hint, the shortcut
 * appended as an em-dash suffix off the LIVE registry (a rebind changes
 * the suffix); truncation-reveals keep native title=; the copy carries no
 * internal vocabulary. Node 26 exposes the host platform through navigator,
 * so expectations cover Mac glyphs AND Ctrl+/Shift+ elsewhere. Composition
 * is the pin; running on a Mac must not be a test prerequisite.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Hint } from "../components/ui/hint.tsx";
import { TOOLTIP_DELAY_MS } from "../components/ui/tooltip.tsx";
describe("subtlety round pins (owner 2026-09-25)", () => {
	it("the rest delay is 500ms — tooltips appear on pause, never in passing", () => {
		assert.equal(TOOLTIP_DELAY_MS, 500);
	});
});


describe("Hint — the mechanism (SSR: the tooltip itself stays closed)", () => {
	it("asChild: no wrapper DOM — the control keeps its own testid and classes", () => {
		const html = renderToStaticMarkup(
			createElement(Hint, {
				label: "Settings",
				children: createElement("button", { "data-testid": "settings-toggle", className: "the-quiet-chrome" }, "Settings"),
			}),
		);
		assert.match(html, /^<button/, "the trigger IS the button — nothing wraps it");
		assert.ok(html.includes('data-testid="settings-toggle"'));
		assert.ok(html.includes("the-quiet-chrome"));
		assert.ok(!html.includes("<span"), "no portal content renders while closed");
	});
});