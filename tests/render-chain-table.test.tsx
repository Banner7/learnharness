import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { ChainTableBody, ChainTableOverlay } from "../components/chain-table.tsx";
import type { ChainSort } from "../components/chain-table.tsx";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import { ServerEventsProvider } from "../components/server-events.tsx";

/** The fixture graph — two follows-chains + one standalone:
 *  a → c1 ← b  (chain one, conclusion born chat1), d → e (chain two,
 *  conclusion born notes1), solo (singleton born chat1). b is born
 *  chat2 — a PREMISE-only birth: no chain concludes there, so chat2
 *  never appears as a group (the conclusion's-cluster law). */
function node(id: string, name: string, statement: string, chatId: string | null): GraphNode {
	return {
		id,
		name,
		statement,
		aliases: [] as string[],
		state: "new",
		createdAt: "2026-09-20T10:00:00.000Z",
		provenance: chatId === null ? [] : [{ chatId, messageId: `m_${id}` }],
	} as unknown as GraphNode;
}

const NODES: GraphNode[] = [
	node("a", "Premise one", "Statement A.", "chat1"),
	node("b", "Premise two", "Statement B.", "chat2"),
	node("c1", "Conclusion", "Statement C.", "chat1"),
	node("d", "Support", "Statement D.", null),
	node("e", "Follow-up", "Statement E with keyword zebra.", "notes1"),
	node("solo", "Standalone", "Statement S.", "chat1"),
	node("orphan", "Orphan", "Statement O.", null),
];

const CHAINS: GraphChain[] = [
	{ id: "c1", premises: ["a", "b"], conclusion: "c1", provenance: [], createdAt: "2026-09-20T10:00:00.000Z" },
	{ id: "e", premises: ["d"], conclusion: "e", provenance: [], createdAt: "2026-09-20T10:00:00.000Z" },
];

const BASE = {
	nodes: NODES,
	chains: CHAINS,
	sessions: { chat1: "Ethics lesson", chat2: "Second chat" },
	fileSources: { notes1: "notes/raw/ethics.md" },
	query: "",
	onQuery: () => {},
	sort: { col: "name", dir: 1 } as ChainSort,
	onSort: () => {},
	selection: new Set<string>(),
	selectedSources: new Set<string>(),
	selectMode: false,
	expandedClusters: new Set<string>(),
	expandedChains: new Set<string>(),
	onToggleCluster: () => {},
	onToggleChain: () => {},
	onToggleNodes: () => {},
	onClear: () => {},
	onGenerate: () => {},
	onDelete: () => {},
	onClose: () => {},
};

function render(props: Partial<typeof BASE> = {}) {
	return renderToStaticMarkup(React.createElement(ChainTableBody, { ...BASE, ...props }));
}

describe("ChainTableBody — clusters", () => {
	it("collapsed by default; source labels use the file basename, not the import path", () => {
		const html = render();
		assert.ok(html.includes('data-testid="cluster-group-chat1"'));
		assert.ok(html.includes('data-testid="cluster-group-notes1"'));
		assert.ok(html.includes("Ethics lesson"));
		assert.ok(!html.includes("notes/raw/ethics.md"), "import path is not a display name");
		assert.ok(!html.includes('data-testid="chain-row-c1"'), "no chain row when collapsed");
	});

	it("chains live in their CONCLUSION's cluster; a premise-only birth never becomes a group", () => {
		const html = render();
		assert.ok(!html.includes("cluster-group-chat2"));
		assert.ok(!html.includes("Second chat"));
		assert.ok(html.includes("unlabeled"), "an unnameable conclusion birth forms one unlabeled group");
	});
});

describe("ChainTableBody — chain rows", () => {
	it("a chain row carries the derivation as its aria-label; a singleton reads as having no premises", () => {
		const html = render({ expandedClusters: new Set(["chat1"]) });
		assert.ok(html.includes('aria-label="Premise one, Premise two → Conclusion"'));
		assert.ok(html.includes('aria-label="Standalone (no premises)"'));
	});

	it("expanding a chain reveals member statements", () => {
		const html = render({ expandedClusters: new Set(["chat1"]), expandedChains: new Set(["c1"]) });
		assert.ok(html.includes("Statement A."));
		assert.ok(html.includes("Statement C."));
	});

	it("Props sort orders cluster rows AND chains within", () => {
		const html = render({ sort: { col: "props", dir: 1 }, expandedClusters: new Set(["chat1"]) });
		const unlabeled = html.indexOf("cluster-group-\0unlabeled");
		const notes = html.indexOf('data-testid="cluster-group-notes1"');
		const chat = html.indexOf('data-testid="cluster-group-chat1"');
		assert.ok(unlabeled > 0 && notes > 0 && chat > 0, "all three groups render");
		assert.ok(unlabeled < notes && notes < chat, "1 < 2 < 4 member ids ascending");
		const soloRow = html.indexOf('data-testid="chain-row-solo"');
		const c1Row = html.indexOf('data-testid="chain-row-c1"');
		assert.ok(soloRow > 0 && c1Row > 0 && soloRow < c1Row, "chain sizes ascending within the cluster");
	});
});

describe("ChainTableBody — selection bar", () => {
	it("Delete rides only with a source selection", () => {
		assert.ok(!render({ expandedClusters: new Set(["chat1"]) }).includes('data-testid="chain-delete"'));
		const html = render({ selectedSources: new Set(["chat1", "notes1"]) });
		assert.ok(html.includes("2 sources"));
		assert.ok(html.includes('data-testid="chain-delete"'));
	});

	it("a premise WITHOUT its conclusion derives as the singleton it becomes", () => {
		const html = render({ selectMode: true, selection: new Set(["a", "d"]) });
		assert.ok(html.includes("2 nodes → 2 chains"));
	});
});

describe("ChainTableBody — search", () => {
	it("matching clusters auto-expand, non-matching chains hide, the selection bar is unfiltered", () => {
		const aliased = NODES.map((n) => (n.id === "b" ? { ...n, aliases: ["zebra alias"] } : n));
		const html = render({ nodes: aliased, selectMode: true, query: "zebra", selection: new Set(["a", "b", "c1"]) });
		assert.ok(html.includes('data-testid="chain-row-c1"'), "alias match");
		assert.ok(html.includes('data-testid="chain-row-e"'), "statement match");
		assert.ok(!html.includes('data-testid="chain-row-solo"'));
		assert.ok(html.includes("3 nodes → 1 chain"));
		assert.ok(render({ query: "qqqq" }).includes('data-testid="chain-table-nomatch"'));
	});
});

describe("ChainTableOverlay — the lifted practice pick", () => {
	function overlay(extra: Record<string, unknown> = {}) {
		return renderToStaticMarkup(
			React.createElement(ServerEventsProvider, { children: React.createElement(ChainTableOverlay, {
				open: true,
				nodes: NODES,
				chains: CHAINS,
				sessions: { chat1: "Ethics lesson", chat2: "Follow-up", notes1: "Notes" },
				fileSources: {},
				onClose: () => {},
				...extra,
			} as never) }),
		);
	}

	it("controlled selection drives the bar; select mode offers Done and never Delete", () => {
		const html = overlay({ selectMode: true, controlledSelection: new Set(["a", "b", "c1"]) });
		assert.ok(html.includes("3 nodes → 1 chain"));
		assert.ok(html.includes('data-testid="chain-practice-done"'));
		assert.ok(!html.includes('data-testid="chain-delete"'));
	});

	it("browse mode cannot delete a lifted graph-node selection", () => {
		const html = overlay({ controlledSelection: new Set(["a"]) });
		assert.ok(!html.includes('data-testid="chain-delete"'));
		assert.ok(!html.includes('data-testid="chain-practice-done"'));
	});
});
