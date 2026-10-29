/** The minimal home's KnowledgeSummary — one quiet line about the map
 * (redesign 2026-10-27; replaced the stacked counts). Pure body: props in,
 * markup out. */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, it } from "node:test";
import { KnowledgeSummary } from "../components/minimal-home.tsx";

function render(propositions: number, chains: number) {
	return renderToStaticMarkup(React.createElement(KnowledgeSummary, { propositions, chains }));
}

describe("KnowledgeSummary — the quiet home summary", () => {
	it("singularizes: one of each never reads '1 ideas'", () => {
		const html = render(1, 1);
		assert.ok(html.includes("1 idea and 1 connection."));
	});

	it("the empty knowledge base says so — import is the entry point", () => {
		const html = render(0, 0);
		assert.ok(html.includes("Import notes"), "the hint names the entry point");
		assert.ok(!html.includes("0 ideas"));
	});
});
