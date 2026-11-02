import assert from "node:assert/strict";
import { it } from "node:test";
import type { NotesSource } from "../src/core/contracts.ts";
import { parseVaultExclude, reconcileVault, vaultPathExcluded } from "../src/core/vault-sync.ts";

const T0 = "2026-11-01T00:00:00.000Z";
const T1 = "2026-11-01T01:00:00.000Z";
const followed = (id: string, path: string, contentHash: string, extra: Partial<NotesSource["vault"]> = {}): NotesSource =>
	({ id, filePath: path, importedAt: T0, vault: { path, contentHash, changedAt: T0, extractedHash: contentHash, ...extra } });
let n = 0;
const ids = () => `src_new${++n}`;

it("a moved file keeps its source id, usage and extracted state", () => {
	const source = { ...followed("src_a", "math/Old.md", "h1"), extractions: [] };
	const r = reconcileVault([source], [{ path: "physics/New.md", hash: "h1" }], T1, ids);
	assert.equal(r.renamed, 1);
	assert.equal(r.created, 0);
	assert.equal(r.upserts[0]!.id, "src_a");
	assert.equal(r.upserts[0]!.filePath, "physics/New.md");
	assert.equal(r.upserts[0]!.vault!.extractedHash, "h1");
});

it("a skipped note is never a rename source for a new file with the same bytes (audit fix, 2026-11-03)", () => {
	const skipped = followed("src_tpl", "Templates/Daily.md", "h1");
	const r = reconcileVault([skipped], [{ path: "notes/Copy.md", hash: "h1" }], T1, ids, ["Templates/"]);
	assert.equal(r.renamed, 0);
	assert.equal(r.created, 1);
	assert.notEqual(r.upserts.find((s) => s.filePath === "notes/Copy.md")!.id, "src_tpl");
});

it("a vanished file is marked missing once, never dropped", () => {
	const first = reconcileVault([followed("src_a", "a.md", "h1")], [], T1, ids);
	assert.equal(first.missing, 1);
	assert.equal(first.upserts[0]!.vault!.missingSince, T1);
	assert.equal(reconcileVault(first.upserts, [], "2026-11-02T00:00:00.000Z", ids).upserts.length, 0, "missingSince keeps its first stamp");
});

it("a file returning to its path clears missing and keeps the id", () => {
	const r = reconcileVault([followed("src_a", "a.md", "h1", { missingSince: T0 })], [{ path: "a.md", hash: "h1" }], T1, ids);
	assert.equal(r.restored, 1);
	assert.equal(r.upserts[0]!.id, "src_a");
	assert.equal(r.upserts[0]!.vault!.missingSince, undefined);
});

it("an edit restarts the quiet clock but leaves extractedHash for the extractor to advance", () => {
	const r = reconcileVault([followed("src_a", "a.md", "h1")], [{ path: "a.md", hash: "h2" }], T1, ids);
	assert.equal(r.changed, 1);
	assert.deepEqual([r.upserts[0]!.vault!.contentHash, r.upserts[0]!.vault!.changedAt, r.upserts[0]!.vault!.extractedHash], ["h2", T1, "h1"]);
});

it("an unchanged vault writes nothing", () => {
	assert.equal(reconcileVault([followed("src_a", "a.md", "h1")], [{ path: "a.md", hash: "h1" }], T1, ids).upserts.length, 0);
});

it("ambiguous identical content mints a new source instead of guessing a move", () => {
	const r = reconcileVault([followed("src_a", "a.md", "h1"), followed("src_b", "b.md", "h1")], [{ path: "c.md", hash: "h1" }], T1, ids);
	assert.equal(r.renamed, 0);
	assert.equal(r.created, 1);
	assert.equal(r.missing, 2);
});

it("an unfollowed upload with the same name is never adopted or touched", () => {
	const upload: NotesSource = { id: "src_up", filePath: "a.md", importedAt: T0 };
	const r = reconcileVault([upload], [{ path: "a.md", hash: "h1" }], T1, ids);
	assert.equal(r.created, 1);
	assert.notEqual(r.upserts[0]!.id, "src_up");
	assert.equal(r.upserts[0]!.vault!.extractedHash, undefined, "a new note awaits its first extraction");
});

it("exclusions match folders from the root and exact files only", () => {
	const exclude = parseVaultExclude(" lh/, /index.md ,, plans/ ");
	assert.deepEqual(exclude, ["lh/", "index.md", "plans/"]);
	assert.ok(vaultPathExcluded("lh/chat.md", exclude));
	assert.ok(vaultPathExcluded("index.md", exclude));
	assert.ok(!vaultPathExcluded("math/index.md", exclude));
	assert.ok(!vaultPathExcluded("math/lh/x.md", exclude));
	assert.ok(!vaultPathExcluded("plansx/a.md", exclude));
});

it("glob skip patterns: * stays in a folder, ** crosses folders, folder globs cover their subtree", () => {
	for (const [path, pattern, skipped] of [
		["a/b/Templates/t.md", "**/Templates/", true], ["Templates/t.md", "**/Templates/", true], ["a/MyTemplates/t.md", "**/Templates/", false],
		["d.excalidraw.md", "*.excalidraw.md", true], ["a/d.excalidraw.md", "*.excalidraw.md", false], ["a/d.excalidraw.md", "**/*.excalidraw.md", true],
		["a/drafts/x.md", "**/drafts/**", true], ["drafts.md", "**/drafts/**", false], ["axb.md", "a?b.md", true], ["a/b.md", "a?b.md", false],
	] as const) assert.equal(vaultPathExcluded(path, [pattern]), skipped, `${pattern} vs ${path}`);
	// The scanner prunes a directory by testing "dir/" — a folder glob must match it.
	assert.ok(vaultPathExcluded("x/drafts/", ["**/drafts/**"]));
});
