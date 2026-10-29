/**
 * BIRTH-SESSION CLUSTERING + THE PROBER GRAPH-TOOLS DATA SEAM (wave 7,
 * owner-locked 2026-09-23): embeddings are dead — a proposition's cluster
 * is the session that created it, derived on read from provenance
 * (session-clusters.ts); labels are session names; the prober tools read a
 * session list + per-session propositions with the extractor's latest
 * understanding level and its own timestamp. All in-memory fakes — the
 * fs-backed snapshot join (with the real store adapters) lives in
 * graph.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode, NotesSource, ChatSummary } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import {
	graphSessionIndex,
	graphSessionPropositions,
	graphSnapshot,
	type GraphDeps,
} from "../src/core/graph.ts";
import { birthSessionOf, birthSessionPartition } from "../src/core/session-clusters.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });
const node = (id: string, name: string, provenance: Array<{ chatId: string; messageId: string }>): GraphNode => ({
	id,
	name,
	statement: `${name} statement`,
	aliases: [],
	createdAt: "2026-09-23T00:00:00.000Z",
	provenance,
});

function fakeStores(
	nodes: GraphNode[],
	over: {
		chats?: Array<Pick<ChatSummary, "id" | "title" | "createdAt" | "updatedAt">>;
		sources?: Array<Pick<NotesSource, "id" | "filePath" | "importedAt">>;
		chains?: GraphChain[];
	} = {},
): GraphDeps {
	const chains: GraphChain[] = over.chains ?? [];
	const graphStore: GraphStore = {
		readNodes: () => nodes,
		readChains: () => chains,
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () =>
			(over.sources ?? []).map((s) => ({ ...s, extractions: [] }) as unknown as NotesSource),
	} as unknown as GraphStore;
	const chatStore: ChatStore = {
		listChats: () =>
			(over.chats ?? []).map((c) => ({ ...c, messageCount: 0 }) as unknown as ChatSummary),
		getChat: (id: string) =>
			((over.chats ?? []).find((c) => c.id === id) as unknown as ChatSummary) ?? undefined,
	} as unknown as ChatStore;
	return { chatStore, graphStore };
}

// ─── the partition ──────────────────────────────────────────────────────────

describe("birthSessionPartition", () => {
	it("groups by the first provenance point, dedupes repeated lines, sorts deterministically", () => {
		const nodes = [
			node("a", "A", [pt("chat1")]),
			node("b", "B", [pt("chat1")]),
			node("c", "C", [pt("chat2")]),
			node("a", "A-linked", [pt("chat2")]), // link-append line for "a": ignored (first defines)
			node("d", "D", [pt("chat1")]),
		];
		assert.deepEqual(birthSessionPartition(nodes), [
			{ id: "chat1", members: ["a", "b", "d"] },
			{ id: "chat2", members: ["c"] },
		]);
	});

	it("a SHARED node belongs to its birth session only — later contributors never claim it", () => {
		const nodes = [
			node("born-1", "X", [pt("chat1")]),
			node("born-1", "X-linked", [pt("chat2")]), // chat2 re-encountered it
			node("born-2", "Y", [pt("chat2")]),
		];
		assert.deepEqual(birthSessionPartition(nodes), [
			{ id: "chat1", members: ["born-1"] },
			{ id: "chat2", members: ["born-2"] },
		], "chat2 holds only what it BIRTHED — sizes tie (1/1), id order breaks it");
	});

	it("deletion re-attribution: a stripped birth falls to the earliest remaining contributor; no provenance = unclustered", () => {
		// What delete-nodes leaves behind: the birth session's points are
		// stripped from surviving lines — the merged provenance walks forward.
		const reattributed = node("survivor", "S", [pt("chat2"), pt("chat3")]);
		assert.equal(birthSessionOf(reattributed), "chat2");
		const naked = node("naked", "N", []);
		assert.equal(birthSessionOf(naked), null);
		const partition = birthSessionPartition([reattributed, naked]);
		assert.deepEqual(partition, [{ id: "chat2", members: ["survivor"] }], "the naked node joins nothing");
	});
});

// ─── notes files as birth sessions (production shape) ────────────────────────

describe("notes files as birth sessions", () => {
	// The mapping-line fallback is GONE (owner, 2026-09-29): the mappings
	// ledger itself died with per-job in-memory resolution, and every merge
	// writes provenance points — the src id IS the birth session.
	it("graphSessionIndex lists imported files as kind:file with birth counts (production shape)", () => {
		const nodes = [node("a", "Alpha", [pt("src_abc")]), node("b", "Beta", [pt("src_abc")]), node("c", "Gamma", [pt("src_abc")])];
		const deps = fakeStores(nodes, {
			sources: [{ id: "src_abc", filePath: "/vault/learn vim.md", importedAt: "2026-09-22T00:00:00.000Z" }],
		});
		const index = graphSessionIndex(deps);
		assert.deepEqual(index, [
			{
				id: "src_abc",
				name: "/vault/learn vim.md",
				kind: "file",
				createdAt: "2026-09-22T00:00:00.000Z",
				updatedAt: "2026-09-22T00:00:00.000Z",
				propositions: 3,
			},
		], "the file births under its src id; the childless chat has no entry (birth sessions only)");
	});

	it("graphSessionPropositions lists the file's births under the src id (a pure birth list, 2026-09-27)", () => {
		const deps = fakeStores([node("a", "Alpha", [pt("src_abc")]), node("b", "Beta", [pt("src_abc")])], {
			sources: [{ id: "src_abc", filePath: "/vault/learn vim.md", importedAt: "2026-09-22T00:00:00.000Z" }],
		});
		assert.deepEqual(graphSessionPropositions(deps, "src_abc"), [
			{ nodeId: "a", name: "Alpha" },
			{ nodeId: "b", name: "Beta" },
		]);
	});
});

// ─── the prober data seam ───────────────────────────────────────────────────

describe("graphSessionIndex (the prober's session list)", () => {
	it("birth counts, chat/file kinds, recency order, deleted records fall back honestly", () => {
		const nodes = [
			node("a", "A", [pt("chat1")]),
			node("b", "B", [pt("chat1")]),
			node("c", "C", [pt("chat1")]),
			node("d", "D", [pt("src_notes")]),
			node("e", "E", [pt("gone")]), // its chat record no longer exists
		];
		const deps = fakeStores(nodes, {
			chats: [
				{ id: "chat1", title: "Older session", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z" },
			],
			sources: [{ id: "src_notes", filePath: "/vault/notes.md", importedAt: "2026-09-22T00:00:00.000Z" }],
		});
		const index = graphSessionIndex(deps);
		assert.deepEqual(index, [
			{
				id: "src_notes",
				name: "/vault/notes.md",
				kind: "file",
				createdAt: "2026-09-22T00:00:00.000Z",
				updatedAt: "2026-09-22T00:00:00.000Z",
				propositions: 1,
			},
			{
				id: "chat1",
				name: "Older session",
				kind: "chat",
				createdAt: "2026-09-20T00:00:00.000Z",
				updatedAt: "2026-09-21T00:00:00.000Z",
				propositions: 3,
			},
			{
				id: "gone",
				name: "gone",
				kind: "file",
				createdAt: null,
				updatedAt: null,
				propositions: 1,
			},
		], "most recent first; the undatable record sinks and names itself by id");
	});
});

describe("graphSessionPropositions (the per-session view)", () => {
	it("birth propositions — a pure list, no evaluations (2026-09-27 cleanup)", () => {
		const nodes = [
			node("a", "Alpha", [pt("chat1")]),
			node("b", "Beta", [pt("chat1")]),
			node("c", "Gamma", [pt("chat2")]), // born elsewhere — never listed under chat1
		];
		const deps = fakeStores(nodes);
		assert.deepEqual(graphSessionPropositions(deps, "chat1"), [
			{ nodeId: "a", name: "Alpha" },
			{ nodeId: "b", name: "Beta" },
		]);
	});
});
