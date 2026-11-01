import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { after, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-source-organization-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { GET, POST } = await import("../server/routes/graph/sources/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { SOURCE_ORGANIZATION_FILE } = await import("../config.ts");
const change = (action: unknown) => POST(new Request("http://localhost/api/graph/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) }));
const sourceId = (filePath: string) => `src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;

it("GET is a non-writing read and inventories all sessions, imported records and missing provenance", async () => {
	const before = await GET(); assert.equal(before.status, 200);
	assert.deepEqual((await before.json()).sources, []);
	assert.equal(fs.existsSync(SOURCE_ORGANIZATION_FILE), false);
	const chat = stores.chatStore.createChat("Unextracted session");
	stores.graphStore.upsertSource({ id: sourceId("Root/empty.md"), filePath: "Root/empty.md", importedAt: "2026-10-30T00:00:00Z" });
	stores.graphStore.appendNode({ id: "n_orphan", name: "Orphan", statement: "A record is missing.", aliases: [], createdAt: "2026-10-30T00:00:00Z", provenance: [{ chatId: "gone", messageId: "m1" }] });
	const { sources } = await (await GET()).json();
	assert.equal(sources.find((s: { id: string }) => s.id === chat.id).label, "Unextracted session");
	assert.equal(sources.find((s: { kind: string }) => s.kind === "notes").label, "empty");
	assert.equal(sources.find((s: { id: string }) => s.id === "gone").kind, "missing");
});

it("rename-source persists a display name for an uploaded source without changing its identity or graph ledgers", async () => {
	const filePath = "Course/Sub/My_Notes.v2.pdf", id = sourceId(filePath);
	stores.graphStore.upsertSource({ id, filePath, importedAt: "2026-10-30T00:00:00Z", extractions: [] });
	const before = { nodes: stores.graphStore.readNodes(), chains: stores.graphStore.readChains(), source: stores.graphStore.readSources().find((s) => s.id === id) };
	assert.equal((await change({ action: "rename-source", id, name: "Renamed book" })).status, 200);
	const directory = await (await GET()).json();
	assert.equal(directory.sources.find((s: { id: string }) => s.id === id).label, "Renamed book");
	assert.deepEqual(stores.sourceOrganizationStore.read(), { version: 2, names: { [id]: "Renamed book" } });
	assert.deepEqual(stores.graphStore.readNodes(), before.nodes); assert.deepEqual(stores.graphStore.readChains(), before.chains);
	assert.deepEqual(stores.graphStore.readSources().find((s) => s.id === id), before.source);
	assert.ok(fs.existsSync(SOURCE_ORGANIZATION_FILE));
});

it("session rename uses its existing title without activity churn; a vault note is named by the vault", async () => {
	const chat = stores.chatStore.createChat("Original session");
	const response = await change({ action: "rename-source", id: chat.id, name: "Edited session" }); assert.equal(response.status, 200);
	assert.equal(stores.chatStore.getChat(chat.id)?.title, "Edited session");
	assert.equal(stores.chatStore.getChat(chat.id)?.updatedAt, chat.updatedAt);
	// A followed note cannot be renamed from LH (owner, 2026-11-01).
	const id = sourceId("math/Note.md");
	stores.graphStore.upsertSource({ id, filePath: "math/Note.md", importedAt: "2026-11-01", vault: { path: "math/Note.md", contentHash: "h", changedAt: "2026-11-01", extractedHash: "h" } });
	assert.equal((await change({ action: "rename-source", id, name: "Nope" })).status, 400);
	assert.equal(stores.sourceOrganizationStore.read().names[id], undefined);
});

it("rename-source refuses unknown/missing sources and invalid shapes", async () => {
	assert.equal((await change({ action: "rename-source", id: "unknown", name: "x" })).status, 400);
	assert.equal((await change({ action: "create-folder", name: "Empty", parentId: null })).status, 400);
	assert.equal((await change({ action: "move", kind: "source", id: "x", parentId: null })).status, 400);
	assert.equal((await change({ action: "rename-source", id: "x", name: "   " })).status, 400);
});

it("malformed, oversized and failed streams refuse before metadata writes", async () => {
	stores.graphStore.upsertSource({ id: sourceId("a.md"), filePath: "a.md", importedAt: "2026-10-30" });
	const before = fs.existsSync(SOURCE_ORGANIZATION_FILE) ? fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8") : null;
	for (const request of [new Request("http://localhost/api/graph/sources", { method: "POST", body: "{" }), new Request("http://localhost/api/graph/sources", { method: "POST", body: "x".repeat(65537) }), new Request("http://localhost/api/graph/sources", { method: "POST", body: new ReadableStream({ start(c) { c.error(new Error("synthetic broken stream")); } }), duplex: "half" } as RequestInit)]) assert.equal((await POST(request)).status, 400);
	assert.equal(fs.existsSync(SOURCE_ORGANIZATION_FILE) ? fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8") : null, before);
});

it("version-1 folders/placements migrate to version-2 names; corrupt/newer data refuses", async () => {
	// The pre-fork shape loads and drops folders/folderId, keeping only names.
	fs.writeFileSync(SOURCE_ORGANIZATION_FILE, JSON.stringify({ version: 1, folders: [{ id: "f1", name: "Course", parentId: null, createdAt: "x" }], placements: { a: { folderId: "f1", name: "My book" }, b: { folderId: "f1" } } }));
	assert.equal((await GET()).status, 200);
	assert.deepEqual(stores.sourceOrganizationStore.read(), { version: 2, names: { a: "My book" } });
	// The next write persists version 2.
	const id = sourceId("a.md");
	stores.graphStore.upsertSource({ id, filePath: "a.md", importedAt: "2026-10-30" });
	assert.equal((await change({ action: "rename-source", id, name: "New" })).status, 200);
	assert.deepEqual(JSON.parse(fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8")), { version: 2, names: { a: "My book", [id]: "New" } });
	// Corrupt and newer-than-this-app data refuse reads and writes without overwriting bytes.
	const good = fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8");
	try {
		for (const value of ["{", '{"version":3,"names":{}}', '{"version":2,"names":{"a":4}}']) {
			fs.writeFileSync(SOURCE_ORGANIZATION_FILE, value);
			assert.equal((await GET()).status, 500);
			assert.equal((await change({ action: "rename-source", id, name: "Do not overwrite" })).status, 500);
			assert.equal(fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8"), value);
		}
	} finally { fs.writeFileSync(SOURCE_ORGANIZATION_FILE, good); }
});
