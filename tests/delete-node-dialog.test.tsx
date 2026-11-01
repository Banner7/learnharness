import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DeleteNodeBody, DeleteNodeDialog, EXTRACTION_RETRY_LINE } from "../components/delete-node-dialog.tsx";

function bodyAt(nodes: { id: string; name: string }[], extra?: { failure?: { code: string; error: string } | null; busy?: boolean }) {
	return renderToStaticMarkup(
		createElement(DeleteNodeBody, {
			nodes,
			busy: extra?.busy ?? false,
			failure: extra?.failure ?? null,
			onClose: () => {},
			onRun: () => {},
		}),
	);
}

describe("DeleteNodeDialog", () => {
	it("null and empty nodes both render nothing", () => {
		for (const nodes of [null, []] as ({ id: string; name: string }[] | null)[]) {
			assert.equal(renderToStaticMarkup(createElement(DeleteNodeDialog, { nodes, onClose: () => {}, onDeleted: () => {} })), "");
		}
	});

	it("multi-node names cap at 8 + and-K-more", () => {
		const ten = bodyAt(Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, name: `Prop ${i}` })));
		assert.match(ten, /Delete 10 nodes\?/);
		assert.match(ten, /Prop 7/);
		assert.doesNotMatch(ten, /Prop 8</);
		assert.match(ten, /, and 2 more/);
	});

	it("the 409 replaces the raw line with the retry line; other codes show their own error", () => {
		const conflict = bodyAt([{ id: "kepler", name: "Kepler" }], { failure: { code: "extraction_running", error: "server line" } });
		assert.ok(conflict.includes(EXTRACTION_RETRY_LINE));
		assert.doesNotMatch(conflict, /server line/);
		assert.match(conflict, /data-testid="node-delete-retry"/);
		const plain = bodyAt([{ id: "kepler", name: "Kepler" }], { failure: { code: "not_found", error: "No such node" } });
		assert.match(plain, /No such node/);
	});

	it("busy disables both buttons", () => {
		const html = bodyAt([{ id: "kepler", name: "Kepler" }], { busy: true });
		assert.match(html, /data-testid="node-delete-cancel"[^>]*disabled/);
		assert.match(html, /data-testid="node-delete-confirm"[^>]*disabled/);
	});
});
