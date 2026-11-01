import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import type { GraphChain, GraphNode } from "../src/core/index.ts";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vault-reextract-"));
process.env.LH_DATA_DIR = root; process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
const { stores } = await import("../src/server/stores.ts");
const { getGraph } = await import("../src/core/graph.ts");
const { detachSourceTraces, pruneDetachedNodes } = await import("../src/core/graph-deletion.ts");
const { DELETE, POST } = await import("../server/routes/graph/sources/route.ts");
beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root); fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}\n"); });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const node = (id: string, sources: string[]): GraphNode =>
	({ id, name: id, statement: `${id} statement`, aliases: [], createdAt: "2026-11-01", provenance: sources.map((chatId) => ({ chatId, messageId: "" })) });
const chain = (id: string, premises: string[], conclusion: string, sources: string[]): GraphChain =>
	({ id, premises, conclusion, createdAt: "2026-11-01", provenance: sources.map((chatId) => ({ chatId, messageId: "" })) });
const ids = () => new Set(getGraph(stores.graphStore).nodes.map((n) => n.id));

it("re-extraction keeps re-linked ideas on their ids, prunes only unsupported ones, spares other sources", () => {
	for (const n of [node("kept", ["src_v"]), node("stale", ["src_v"]), node("shared", ["src_v", "chat_1"]), node("other", ["chat_1"])]) stores.graphStore.appendNode(n);
	stores.graphStore.appendChain(chain("arg_v", ["kept"], "stale", ["src_v"]));
	stores.graphStore.appendChain(chain("arg_c", ["shared"], "other", ["chat_1"]));

	const candidates = detachSourceTraces(stores.graphStore, "src_v");
	assert.deepEqual([...candidates].sort(), ["kept", "stale"], "a node another source backs is never a candidate");
	assert.deepEqual([...ids()].sort(), ["kept", "other", "shared", "stale"], "detach deletes no node");
	assert.ok(!stores.graphStore.readChains().some((c) => c.id === "arg_v"), "the note's own assertion is dropped for re-assertion");

	// The re-run's auditor links the unchanged idea back (a link line).
	stores.graphStore.appendNode(node("kept", ["src_v"]));
	assert.equal(pruneDetachedNodes(stores.graphStore, candidates), 1);
	assert.deepEqual([...ids()].sort(), ["kept", "other", "shared"]);
	assert.ok(stores.graphStore.readChains().some((c) => c.id === "arg_c"), "other sources' chains survive");
	const shared = getGraph(stores.graphStore).nodes.find((n) => n.id === "shared")!;
	assert.deepEqual(shared.provenance.map((p) => p.chatId), ["chat_1"]);
});

it("a candidate a concurrent chat extraction re-links survives the prune", () => {
	stores.graphStore.appendNode(node("idea", ["src_v"]));
	const candidates = detachSourceTraces(stores.graphStore, "src_v");
	stores.graphStore.appendNode(node("idea", ["chat_2"]));
	assert.equal(pruneDetachedNodes(stores.graphStore, candidates), 0);
	assert.ok(ids().has("idea"));
});

it("a vault note still in the vault cannot be deleted or reorganized from LH; a missing one can be deleted", async () => {
	const vault = (missingSince?: string) => ({ path: "math/Note.md", contentHash: "h", changedAt: "2026-11-01", extractedHash: "h", ...(missingSince ? { missingSince } : {}) });
	stores.graphStore.upsertSource({ id: "src_v", filePath: "math/Note.md", importedAt: "2026-11-01", vault: vault() });
	stores.graphStore.appendNode(node("idea", ["src_v"]));
	const remove = () => DELETE(new Request("http://localhost/api/graph/sources", { method: "DELETE", body: JSON.stringify({ sourceIds: ["src_v"], folderIds: [], deleteSessions: false }) }));
	const refused = await remove();
	assert.equal(refused.status, 409);
	assert.ok(ids().has("idea"), "the refusal writes nothing");
	const move = await POST(new Request("http://localhost/api/graph/sources", { method: "POST", body: JSON.stringify({ action: "move", kind: "source", id: "src_v", parentId: null }) }));
	assert.equal(move.status, 400);

	stores.graphStore.upsertSource({ id: "src_v", filePath: "math/Note.md", importedAt: "2026-11-01", vault: vault("2026-11-02") });
	assert.equal((await remove()).status, 200);
	assert.ok(!ids().has("idea"));
	assert.deepEqual(stores.sourceOrganizationStore.read().folders, [], "the vault folder overlay is never persisted");
});
