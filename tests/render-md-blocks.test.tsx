/**
 * Render tests for the md-blocks component overrides (Streamdown
 * `components` prop). Idiom shared with render-markdown.test.tsx: static
 * HTML via react-dom/server (no DOM, effects never run — mermaid stays at
 * its skeleton). tsx note: classic JSX transform — the React global shim
 * below provides React.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { chartSize } from "../components/session-overlay.tsx";
import { codeSource, parseAlertMarker } from "../components/md-blocks.tsx";

function render(md: string): string {
	return renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>);
}

describe("md-blocks — code, mermaid, tables, math", () => {
	it("code fences render through the delegated CodeBlock with a copy corner", () => {
		const html = render("```js\nconst x = 1;\n```");
		assert.ok(html.includes('data-streamdown="code-block"'), "the delegated CodeBlock path is kept");
		assert.match(html, /aria-label="Copy code"/);
	});

	it("mermaid renders as the app-owned block, never a code block; source never leaks; no expand without a session", () => {
		const html = render("```mermaid\ngraph TD\nA --> B\n```");
		assert.ok(html.includes('data-testid="md-mermaid"'));
		assert.ok(!html.includes('data-streamdown="code-block"'), "mermaid fences must not render as code blocks");
		assert.ok(!html.includes("graph TD"), "chart source is not leaked as text");
		assert.ok(!html.includes('data-testid="md-mermaid-expand"'), "expand hidden without a session context");
	});

	it("tables render with a copy corner and no fullscreen/download chrome", () => {
		const html = render("| A | B |\n| --- | --- |\n| 1 | 2 |");
		assert.ok(html.includes('data-streamdown="table"'));
		assert.match(html, /aria-label="Copy table"/);
		assert.ok(!html.match(/Fullscreen|aria-label="Download"/));
	});

	it("display math still renders via KaTeX with a TeX copy corner", () => {
		const html = render("$$\n\\int_0^1 x^2\\,dx = \\tfrac{1}{3}\n$$");
		assert.ok(html.includes("katex-display"));
		assert.match(html, /aria-label="Copy equation source"/);
	});
});

describe("md-blocks — pure helpers", () => {
	it("codeSource extracts the fence source from string and element-wrapped children", () => {
		assert.equal(codeSource("const x = 1;"), "const x = 1;");
		assert.equal(codeSource(<span>const x = 1;</span>), "const x = 1;");
	});

	it("parseAlertMarker: non-paragraph openers and marker-less text return null", () => {
		assert.equal(parseAlertMarker("just text"), null);
		assert.equal(parseAlertMarker(null), null);
		assert.equal(parseAlertMarker({ type: "em", props: { children: "x" } } as never), null);
	});

	it("chartSize reads the viewBox from a rendered svg (fallback for degenerate ones)", () => {
		assert.deepEqual(chartSize('<svg viewBox="0 0 900 700" xmlns="..."></svg>'), { w: 900, h: 700 });
		assert.deepEqual(chartSize("<svg></svg>"), { w: 600, h: 400 });
	});
});

describe("md-blocks — key-idea callouts (GitHub alerts, owner round 2026-10-07)", () => {
	it("all five GitHub markers box identically; the marker never leaks", () => {
		for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
			const html = render(`> [!${kind}]\n> Load-bearing words.`);
			assert.ok(html.includes(`data-alert-kind="${kind.toLowerCase()}"`), `${kind} boxes`);
			assert.match(html, /Load-bearing words\./);
			assert.ok(!html.includes(`[!${kind}]`), `${kind} marker never leaks`);
		}
	});

	it("standalone-marker and multi-paragraph callouts keep their prose", () => {
		const standalone = render("> [!IMPORTANT]\n>\n> The payoff lands here.");
		assert.ok(standalone.includes('data-testid="md-callout"'));
		assert.match(standalone, /The payoff lands here\./);
		assert.ok(!standalone.includes("[!IMPORTANT]"));
		const multi = render("> [!IMPORTANT]\n> First the truth.\n>\n> Then the payoff.");
		assert.ok((multi.match(/<p>/g) ?? []).length >= 2, "both paragraphs render inside the box");
	});

	it("plain blockquotes pass through — no box for ordinary quotes", () => {
		const html = render("Before.\n\n> Just an ordinary quote.\n\nAfter.");
		assert.ok(!html.includes('data-testid="md-callout"'));
		assert.match(html, /Just an ordinary quote\./);
	});
});
