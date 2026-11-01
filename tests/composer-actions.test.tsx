import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ComposerActions } from "../components/composer-actions.tsx";
import { DraftShell } from "../components/new-session.tsx";

function documentFor(node: React.ReactNode) {
	return parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
}

describe("composer action row", () => {
	it("renders nothing without a picker", () => {
		assert.equal(renderToStaticMarkup(<ComposerActions picker={false} />), "");
	});

	it("the practice shell preserves a selected node in teaching mode", () => {
		const document = documentFor(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="teach" picks={[{id:"n_1",name:"Parity",statement:"Odd + odd = even."}]} />);
		assert.equal(document.querySelector('[data-testid="practice-props-chip"]')!.textContent, "1 node selected");
		assert.ok(document.querySelector('[data-testid="practice-props-clear"]'));
	});
});
