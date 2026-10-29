import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ComposerActions, NodePickerControl } from "../components/composer-actions.tsx";
import { DraftShell } from "../components/new-session.tsx";

function documentFor(node: React.ReactNode) {
	return parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
}

describe("composer action row", () => {
	it("renders nothing without a picker", () => {
		assert.equal(renderToStaticMarkup(<ComposerActions picker={false} />), "");
	});


	it("picker-only remains left-aligned", () => {
		const document = documentFor(<ComposerActions picker={<NodePickerControl count={0} />} />);
		assert.ok(document.querySelector('[data-testid="composer-actions"]')!.classList.contains("justify-start"));
	});

	it("singular and plural node counts keep Clear in the same wrapping group", () => {
		for (const count of [1, 2]) {
			const document = documentFor(<ComposerActions picker={<NodePickerControl count={count} />} />);
			const chip = document.querySelector('[data-testid="practice-props-chip"]')!;
			const clear = document.querySelector('[data-testid="practice-props-clear"]')!;
			assert.equal(chip.textContent, `${count} ${count === 1 ? "node" : "nodes"} selected`);
			assert.equal(chip.parentElement, clear.parentElement);
			assert.equal(chip.parentElement!.parentElement!.getAttribute("data-testid"), "composer-actions");
			assert.ok(!chip.parentElement!.classList.contains("flex-wrap"), "count and Clear never wrap apart");
		}
	});


	it("the practice shell preserves a selected node in teaching mode", () => {
		const document = documentFor(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="teach" picks={[{id:"n_1",name:"Parity",statement:"Odd + odd = even."}]} />);
		assert.equal(document.querySelector('[data-testid="practice-props-chip"]')!.textContent, "1 node selected");
		assert.ok(document.querySelector('[data-testid="practice-props-clear"]'));
	});
});
