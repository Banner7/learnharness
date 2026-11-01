import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChainTableBody } from "../components/chain-table.tsx";
import { DeleteSourceBody } from "../components/delete-source-dialog.tsx";
import { sourceNameMatches } from "../components/source-folder-tree.tsx";
import type { GraphNode, SourceDirectory } from "../src/core/index.ts";
const directory: SourceDirectory = {
	sources: [
		{ id: "chat", kind: "chat", label: "Not yet extracted", createdAt: "2026-10-29" },
		{ id: "notes", kind: "notes", label: "Named book", filePath: "Course/Week/original.pdf", createdAt: "2026-10-29" },
	],
};
const nodes: GraphNode[] = ["a", "b"].map((id) => ({ id, name: id, statement: id, aliases: [], provenance: [{ chatId: "notes", messageId: "m" }], createdAt: "2026-10-29" }));
const base: Parameters<typeof ChainTableBody>[0] = {
	nodes: [], chains: [], sessions: {}, fileSources: {}, query: "", onQuery() {}, sort: { col: "name", dir: 1 }, onSort() {}, selection: new Set(),
	expandedClusters: new Set(), expandedChains: new Set(), onToggleCluster() {}, onToggleChain() {}, onToggleNodes() {}, onClear() {}, onDelete() {}, onClose() {},
	directory, onOrganizationChange: async () => {},
};
const render = (props: Partial<typeof base> = {}) => renderToStaticMarkup(<ChainTableBody {...base} {...props} />);

it("source inventory includes unextracted chats and zero-graph imported books under their names", () => {
	const html = render({ expandedClusters: new Set(["chat", "notes"]) });
	assert.match(html, /Not yet extracted/); assert.match(html, /Named book/); assert.doesNotMatch(html, /original.pdf/);
	assert.doesNotMatch(html, /No matching chains/);
	assert.match(html, /data-testid="source-group-uploads"/); assert.match(html, /data-testid="source-group-chats"/);
});
it("re-import record dates do not change existing graph groups' Created dates", () => {
	const newer = { ...directory, sources: directory.sources.map((s) => s.id === "notes" ? { ...s, createdAt: "2099-01-01" } : s) };
	const html = render({ nodes, directory: newer, expandedClusters: new Set(["chat", "notes"]) });
	assert.doesNotMatch(html, /2099-01-01/);
	assert.match(html, /2026-10-29/);
});
it("ordinary browsing offers source checks, but only practice offers fine-grained node checks", () => {
	const html = render({ nodes, expandedClusters: new Set(["chat", "notes"]) });
	assert.doesNotMatch(html, /data-testid="(?:prop|chain)-checkbox-/);
	for (const id of ["cluster-checkbox-chat", "cluster-checkbox-notes"]) {
		const tag = html.match(new RegExp(`<input[^>]*data-testid="${id}"[^>]*>`))?.[0];
		assert.ok(tag, id); assert.doesNotMatch(tag, /disabled/, id);
	}
	const practice = render({ selectMode: true, nodes, expandedClusters: new Set(["chat", "notes"]), expandedChains: new Set(["a", "b"]) });
	assert.match(practice, /data-testid="chain-checkbox-a"/); assert.match(practice, /data-testid="prop-checkbox-a"/);
});
it("source names are searchable without needing any extracted nodes", () => {
	assert.equal(sourceNameMatches("Named book", "Named"), true);
	assert.equal(sourceNameMatches("Named book", "xyzxyz"), false);
	assert.match(render({ query: "Not yet" }), /Not yet extracted/);
});
it("a missing note shows its impact and a Delete action", () => {
	const missing: SourceDirectory = { sources: [
		{ id: "m", kind: "notes", label: "Gone note", createdAt: "2026-10-29", vault: "missing", vaultPath: "Gone note.md", missingSince: "2026-10-31T00:00:00Z", ideas: 3, onlyFromThisNote: 1 },
	] };
	const html = render({ directory: missing, expandedClusters: new Set(["m"]) });
	assert.match(html, /missing since Oct 31/);
	assert.match(html, /3 ideas/); assert.match(html, /1 only from this note/);
	assert.match(html, /data-testid="missing-delete-m"/);
});
it("source confirmation explains shared-node survival and makes conversation deletion an unchecked opt-in", () => {
	const html = renderToStaticMarkup(<DeleteSourceBody sources={directory.sources} deleteSessions={false} onDeleteSessions={() => {}} busy={false} failure="" onClose={() => {}} onRun={() => {}} />);
	assert.match(html, /Knowledge supported by other sources survives/); assert.match(html, /can be extracted again/);
	assert.match(html, /graph contributions and extraction coverage are cleared/); assert.match(html, /Also delete the 1 selected session/);
	assert.doesNotMatch(html.match(/<input[^>]+>/)?.[0] ?? "", /checked/);
});
