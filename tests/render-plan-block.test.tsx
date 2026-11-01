import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	PlanBlock,
	PlanPopup,
	blockLayout,
	topoFor,
	wrapTitle,
	GAP_X,
	NODE_H,
	nodeWidth,
	type PopupMessage,
} from "../components/plan-block.tsx";
import type { PlanBlockData, PlanTree } from "../src/core/contracts.ts";

// Plan blocks: the pure layered layout, the frozen-snapshot rendering
// (statuses as carried), and the popup's LIVE derivation.

const CHAIN: PlanTree = {
	nodes: [
		{ id: "a", title: "Alpha node" },
		{ id: "b", title: "Beta node" },
		{ id: "c", title: "Gamma node" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
	],
	version: 1,
};

describe("plan block layout (pure)", () => {
	it("layers a chain top-down, one node per depth row", () => {
		const { order, depth } = topoFor(CHAIN.nodes, CHAIN.edges);
		assert.deepEqual(order.map((n) => n.id), ["a", "b", "c"]);
		assert.equal(depth.get("c"), 2);
		assert.equal(blockLayout(CHAIN.nodes, CHAIN.edges).height, 3 * NODE_H + 2 * 48);
	});

	it("centers same-depth nodes over the widest row; tolerates dangling edges", () => {
		const nodes = [
			{ id: "r", title: "Root" },
			{ id: "x", title: "Left" },
			{ id: "y", title: "Right" },
		];
		const layout = blockLayout(nodes, [
			{ from: "r", to: "x" },
			{ from: "r", to: "y" },
			{ from: "ghost", to: "r" }, // dangling: ignored defensively
		]);
		const W = nodeWidth(wrapTitle("Root"));
		assert.equal(layout.width, 2 * W + GAP_X);
		assert.equal(layout.x.get("r"), (2 * W + GAP_X - W) / 2);
		assert.ok(layout.x.get("x") === 0 && layout.x.get("y") === W + GAP_X);
	});

	it("wrapTitle wraps greedily and NEVER drops content (boxes grow instead)", () => {
		assert.deepEqual(wrapTitle("Chain rule intuition"), ["Chain rule intuition"]);
		assert.deepEqual(wrapTitle("Chain rule intuition and fluency"), ["Chain rule intuition and", "fluency"]);
		// Oversized word hard-chunked at maxChars, nothing lost.
		assert.deepEqual(wrapTitle("supercalifragilisticexpialidocious word"), ["supercalifragilisticexpialid", "ocious word"]);
	});
});

describe("plan block render", () => {
	it("full block renders statuses AS CARRIED (never re-derived)", () => {
		const data: PlanBlockData = {
			kind: "full",
			at: "2026-09-09T12:00:00Z",
			current: null,
			nodes: [
				{ id: "a", title: "Alpha node", status: "visited" },
				{ id: "b", title: "Beta node", status: "upcoming" },
			],
			edges: [{ from: "a", to: "b" }],
		};
		const html = renderToStaticMarkup(<PlanBlock data={data} onOpen={() => {}} />);
		assert.match(html, /data-testid="plan-node-a" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-b" data-status="upcoming"/);
	});
});

describe("plan popup (live derivation)", () => {
	const plan = (tree: PlanTree): PopupMessage => ({ parts: [{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree } }] });
	const quiz = (nodeId: string, answered = true): PopupMessage => ({
		parts: [answered
			? { type: "tool-quiz", state: "output-available", input: { nodeId }, output: { correct: true } }
			: { type: "tool-quiz", state: "input-available", input: { nodeId } }],
	});

	it("derives statuses at click time: latest tagged call → current, earlier → visited", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={[plan(CHAIN), quiz("a"), quiz("b", false)]} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-node-a" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-b" data-status="current"/);
		assert.match(html, /data-testid="plan-node-c" data-status="upcoming"/);
	});

	it("dims an arrow when EITHER end is gray — white needs both ends white (owner, 2026-09-26)", () => {
		const tree: PlanTree = {
			nodes: [
				{ id: "x", title: "Gray origin" },
				{ id: "y", title: "Covered middle" },
				{ id: "z", title: "Covered latest" },
			],
			edges: [
				{ from: "x", to: "y" },
				{ from: "y", to: "z" },
			],
			version: 1,
		};
		const html = renderToStaticMarkup(<PlanPopup messages={[plan(tree), quiz("y"), quiz("z")]} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-node-x" data-status="upcoming"/);
		const dimHeads = (html.match(/marker-end="url\(#.*-dim\)"/g) ?? []).length;
		const whiteHeads = (html.match(/marker-end="url\(#(?:R\d+|[a-z0-9-]+)\)"/g) ?? []).length;
		assert.equal(dimHeads, 1, "the gray-origin edge dims");
		assert.equal(whiteHeads, 1, "the both-white edge stays white");
	});
});
