/**
 * Phase presentation render tests — the transcript boundary rules
 * (components/phase-divider.tsx). The header phase chip retired in the
 * 2026-10-27 redesign (the plan tick strip replaced it). Same tsx
 * classic-JSX shim as render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PhaseDivider, planNodeCount } from "../components/phase-divider.tsx";
import { teachStepIndex } from "../src/core/phases.ts";

describe("PhaseDivider (transcript boundary)", () => {
	it("the plan seam: node count", () => {
		const html = renderToStaticMarkup(<PhaseDivider phase="plan" nodeCount={3} />);
		assert.ok(html.includes('data-testid="phase-divider-plan"'));
		assert.match(html, /Plan · 3 nodes/);
	});

	it("the teach seam: no count", () => {
		const html = renderToStaticMarkup(<PhaseDivider phase="teach" />);
		assert.ok(html.includes('data-testid="phase-divider-teach"'));
		assert.match(html, /Teaching/);
		assert.ok(!html.includes("nodes"));
	});

	it("singular node count", () => {
		const html = renderToStaticMarkup(<PhaseDivider phase="plan" nodeCount={1} />);
		assert.match(html, /Plan · 1 node\b/);
	});

	it("a plan seam without a count still labels itself", () => {
		const html = renderToStaticMarkup(<PhaseDivider phase="plan" />);
		assert.match(html, /Planning/);
	});

	it("probe renders null (never a boundary — phases only advance)", () => {
		assert.equal(renderToStaticMarkup(<PhaseDivider phase="probe" />), "");
	});
});

describe("teachStepIndex (WHERE teaching begins inside the flipping message — owner round 8)", () => {
	const call = { type: "tool-quiz", input: { nodeId: "n1", question: "q?" } };

	it("the flip call in the message's FIRST step → -1 (divider prepends before the message)", () => {
		assert.equal(teachStepIndex([{ type: "step-start" }, { type: "text" }, call]), -1);
	});

	it("a later step: the boundary's step-start index — between plan presentation and teaching", () => {
		// The stacked-dividers bug shape: plan_init + plan text, then a NEW
		// step that poses the first tagged quiz. The seam is the SECOND
		// step-start (index 3), not before the message.
		const parts = [
			{ type: "step-start" },
			{ type: "tool-plan_init", state: "output-available" },
			{ type: "text", text: "Here is your plan." },
			{ type: "step-start" },
			{ type: "text", text: "Let's begin." },
			call,
		];
		assert.equal(teachStepIndex(parts), 3);
	});

	it("no step-start parts at all (defensive): first step → -1", () => {
		assert.equal(teachStepIndex([{ type: "text" }, call]), -1);
	});

	it("an untagged quiz call is not the flip — scan continues to the tagged one", () => {
		const parts = [
			{ type: "step-start" },
			{ type: "tool-quiz", input: { question: "probe quiz — no nodeId" } },
			{ type: "step-start" },
			call,
		];
		assert.equal(teachStepIndex(parts), 2);
	});

	it("explain calls carry nodeId too — same seam", () => {
		const parts = [
			{ type: "step-start" },
			{ type: "text" },
			{ type: "step-start" },
			{ type: "tool-explain", input: { nodeId: "n2", topic: "t" } },
		];
		assert.equal(teachStepIndex(parts), 2);
	});
});

describe("planNodeCount (the seam message's tree)", () => {
	it("counts the first output-available plan tree in the message", () => {
		const count = planNodeCount({
			parts: [
				{ type: "text", text: "Here's your plan." },
				{
					type: "tool-plan_init",
					state: "output-available",
					toolCallId: "p1",
					output: { ok: true, tree: { nodes: [{ id: "a" }, { id: "b" }], edges: [], currentNodeId: null, doneNodeIds: [], version: 1 } },
				},
			],
		});
		assert.equal(count, 2);
	});

	it("skips streaming/failed parts (an empty or failed tree gives no count)", () => {
		assert.equal(
			planNodeCount({ parts: [{ type: "tool-plan_init", state: "input-streaming" }] }),
			undefined,
		);
		assert.equal(
			planNodeCount({
				parts: [
					{ type: "tool-plan_init", state: "output-available", toolCallId: "p1", output: { ok: false, tree: { nodes: [], edges: [], currentNodeId: null, doneNodeIds: [], version: 0 } } },
				],
			}),
			undefined,
			"an empty tree (failed init) carries no count",
		);
		assert.equal(planNodeCount({ parts: [{ type: "text" }] }), undefined);
	});
});
