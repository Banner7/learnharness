/**
 * Render tests for the presentation layer (W3): the \(...\)/\[...\] math
 * delimiter contract, escaped dollars inside math, single-newline line
 * breaks, mermaid routing, and the over-escaped command heal.
 *
 * tsx uses the CLASSIC JSX transform, so `React` must be a resolvable
 * global — the shim below provides it.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { transformMathDelimiters, healOverescapedCommands } from "../src/core/math-delims.ts";

/** Render through MessageResponse in static mode (no streaming/remend artifacts). */
function render(md: string): string {
	return renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>);
}

describe("math delimiter transform (pure unit)", () => {
	it("converts balanced legacy delimiters by position", () => {
		for (const [input, expected] of [
			["a \\(x^2\\) b", "a $$x^2$$ b"],
			["text\n\n\\[\n\\int x\n\\]\n\nmore", "text\n\n$$\n\\int x\n$$\n\nmore"],
			// mid-paragraph display math is padded into a clean block
			["mid \\[x^2\\] para", "mid \n\n$$\nx^2\n$$\n\n para"],
			// indented display math (list items) degrades to the inline form
			["- item\n  \\[\n  x^2\n  \\]\n- next", "- item\n  $$x^2$$\n- next"],
			// a later balanced pair still converts after an unbalanced one
			["\\[ partial\n\nbut \\(ok\\)", "\\[ partial\n\nbut $$ok$$"],
		]) {
			assert.equal(transformMathDelimiters(input!), expected);
		}
	});

	it("leaves currency, escaped delimiters, code, and unbalanced delimiters untouched", () => {
		for (const md of [
			"It costs $5 and $10 more. $$big$$ sums too.",
			"escaped \\\\( and \\\\[ stay",
			"```js\n\\(x\\) and \\[y\\]\n```",
			"run `\\(x\\)` locally",
			"partial \\[ mid-stream",
			"open \\( no close",
		]) {
			assert.equal(transformMathDelimiters(md), md);
		}
	});
});

describe("render — dollar math + legacy compatibility (streamdown + KaTeX)", () => {
	it("inline forms render inline; display forms render display", () => {
		for (const md of ["The map \\(f(x) = x^2\\) is smooth.", "The map $f(x) = x^2$ is smooth."]) {
			const html = render(md);
			assert.ok(html.includes("katex") && !html.includes("katex-display"), md);
		}
		assert.ok(render("Intro:\n\n\\[\n\\int_0^1 x^2\\,dx = \\tfrac{1}{3}\n\\]\n\nOutro.").includes("katex-display"));
		const fenced = render("The symbol $\\Omega$ appears here.\n\n$$\nS = k_B \\ln \\Omega\n$$");
		assert.ok(fenced.includes("katex-display") && fenced.includes("Ω") && !fenced.includes("katex-error"));
	});

	it("renders mid-paragraph \\[...\\] as display math without leaking dollars", () => {
		const html = render("before \\[x^2\\] after");
		assert.ok(html.includes("katex-display"));
		assert.ok(!html.includes("$$"), "no literal $$ leaks");
		assert.ok(!html.includes("katex-error"));
	});

	it("renders display math inside list items without eating the list", () => {
		const html = render("- item one\n  \\[x^2\\]\n- item two");
		assert.ok(html.includes("katex"));
		assert.ok(html.includes("item two"), "the following list item survives");
	});

	it("keeps escaped currency and code examples literal", () => {
		const currency = render("It costs \\$5 and \\$10 more.");
		assert.ok(!currency.includes("katex"));
		assert.match(currency, /\$5 and \$10/);
		const code = render("Use `$x$` here.\n\n```text\n$$\ny = x^2\n$$\n```");
		assert.ok(!code.includes("katex"), "code examples are not math");
		assert.ok(code.includes("$x$"));
	});
});

describe("render — line breaks (remark-breaks)", () => {
	it("a single newline is a hard break, but never inside code blocks", () => {
		assert.match(render("line one\nline two"), /<br\s*\/?>/);
		assert.ok(!render("```js\nline one\nline two\n```").includes("<br"));
	});

	it("keeps GFM tables intact (remark-breaks did not replace the defaults)", () => {
		assert.ok(render("| a | b |\n|---|---|\n| 1 | 2 |").includes("<table"));
	});
});

describe("render — mermaid", () => {
	it("a mermaid fence never takes the code-block path or leaks its source", () => {
		// SSR renders the lazy chunk's Suspense skeleton; assert what must NOT happen.
		const html = render("```mermaid\ngraph TD\nA --> B\n```");
		assert.ok(!html.includes('data-streamdown="code-block"'));
		assert.ok(!html.includes("graph TD"));
		assert.ok(render("```js\nconst x = 1;\n```").includes('data-streamdown="code-block"'), "ordinary fences still do");
	});
});

// ─── escaped dollars inside math (owner, 2026-10-12) ────────────────────────
//
// micromark's mathText closer is code-span logic — ANY size-matched `$` run
// closes, `\$` included — so `$x = \$5$` closed at the escape and errored.
// Inside balanced inline spans, `\$` becomes the dollar-free
// `\text{\textdollar}` BEFORE tokenization.

describe("escaped dollars inside math", () => {
	it("replaces every odd-escaped dollar inside balanced inline spans only", () => {
		assert.equal(transformMathDelimiters("It costs $x = \\$5$ at market."), "It costs $x = \\text{\\textdollar}5$ at market.");
		assert.equal(
			transformMathDelimiters("$\\$3 + \\text{\\$}4 = \\$7$ exactly."),
			"$\\text{\\textdollar}3 + \\text{\\text{\\textdollar}}4 = \\text{\\textdollar}7$ exactly.",
		);
		assert.equal(transformMathDelimiters("$a$ costs $5\\$10$ and $b$"), "$a$ costs $5\\text{\\textdollar}10$ and $b$");
	});

	it("leaves even-backslash dollars, prose, display spans, code, and unbalanced spans untouched", () => {
		for (const md of [
			"$a\\\\$b$ tail", // row break + dollar keeps closing — parity is load-bearing
			"It costs \\$5 flat, then $5 and $10 more.",
			"$$x = \\$5,\\ q = \\$12$$",
			"Type `$x = \\$5$` literally.",
			"```\n$x = \\$5$\n```",
			"Broken: $x = \\$5",
		]) {
			assert.equal(transformMathDelimiters(md), md);
		}
	});

	it("renders each escape-bearing span as one clean span, and later spans survive", () => {
		for (const [md, spans] of [
			["It costs $x = \\$5$ at market.", 1],
			["Line A: $x = \\$5$.\n\nLine B: $y = 2$.\n\nWhat is $2 + 2$?", 3],
			["Price: $\\text{\\$}12$ today.", 1],
			["Old form \\(x = \\$5\\) renders.", 1],
		] as const) {
			const html = render(md);
			assert.equal((html.match(/class="katex"/g) ?? []).length, spans, md);
			assert.ok(!html.includes("katex-error"), md);
		}
		const code = render("Type `$x = \\$5$` literally.");
		assert.ok(!code.includes('class="katex"'));
		assert.ok(code.includes("$x = \\$5$"));
	});
});

describe("over-escaped command heal — doubled backslashes in tool args (owner ruling 2026-10-15)", () => {
	// Some models stochastically DOUBLE LaTeX command backslashes inside JSON
	// tool arguments; KaTeX reads `\\` as a row break and renders the command
	// name as plain letters. TS literals: 4 backslashes = 2 real, 6 = 3 real.

	const GD_QUESTION =
		"Let $f : \\mathbb{R}^n \\to \\mathbb{R}$ be differentiable at $x$, with $\\nabla f(x) \\neq 0$. The directional derivative along a unit direction $u$ is $D_u f(x) = \\nabla f(x)^\\top u$. Among all unit directions $\\|u\\|_2 = 1$, which one makes $D_u f(x) **most negative** (steepest descent)?";

	it("heals doubled/quadrupled commands in every math span form", () => {
		for (const [input, expected] of [
			["$\\\\nabla f$", "$\\nabla f$"],
			["$\\\\\\\\mathbb{R}^n$", "$\\mathbb{R}^n$"],
			["$$\n\\\\nabla f(x)\n$$", "$$\n\\nabla f(x)\n$$"],
			["\\(\\\\nabla\\)", "\\(\\nabla\\)"],
			["$\\\\|u\\\\|_2$", "$\\|u\\|_2$"],
			["$a\\\\,b$", "$a\\,b$"],
			["$a\\\\;b$", "$a\\;b$"],
			["$a\\\\:b$", "$a\\:b$"],
			["$a\\\\!b$", "$a\\!b$"],
		]) {
			assert.equal(healOverescapedCommands(input!), expected);
		}
	});

	it("keeps row breaks, odd runs, non-math text, and unbalanced spans", () => {
		for (const md of [
			"\\begin{pmatrix} 1 \\\\ 2 \\\\\\ 3\\end{pmatrix}",
			"f(x) \\\\& g(x) \\\\[6pt] h(x)",
			"$a \\\\\\nabla b$", // \\ row break + \nabla command
			"path C:\\\\Users\\\\amos",
			"`$\\\\nabla$` in code",
			"```\n$\\\\nabla$\n```",
			"$\\\\nabla",
		]) {
			assert.equal(healOverescapedCommands(md), md);
		}
	});

	it("the doubled question errors in KaTeX; the healed one renders ∇ and ⊤ cleanly", () => {
		const raw = GD_QUESTION.replace(/\\/g, "\\\\");
		const broken = render(raw);
		assert.ok(!broken.includes("∇") && broken.includes("katex-error"));
		const healed = render(healOverescapedCommands(raw));
		assert.ok(healed.includes("∇") && healed.includes("⊤") && healed.includes("mathbb"));
		assert.ok(!healed.includes("katex-error"));
	});
});
