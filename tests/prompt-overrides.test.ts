/**
 * Tests for the prompt-override store (settings-storage wave, 2026-09-19):
 * src/store/prompt-overrides.ts — override file CRUD, the mirror-layout
 * path discipline (traversal guard), the SOURCE-DERIVED segment list, and
 * the route-level contract pins (delete-clears-switch, orphaned-ON-heals).
 *
 * TEST-DIR ISOLATION (contract fix, interlude 2026-09-26): data/prompts
 * holds REAL user override files — this suite must never touch it. The
 * LH_DATA_DIR seam is evaluated at config.ts's MODULE LOAD, so every
 * app-module import below is dynamic, and after() asserts the REAL repo
 * data/prompts survived the suite untouched. This file OWNS the temp dir
 * (one fs owner per file).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-prompt-overrides-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { PROMPTS_OVERRIDE_DIR } = await import("../config.ts");
const teacherAgent = await import("../src/agent/teacher-agent.ts");
const { allSegmentPaths, effectivePromptSegments } = await import("../src/agent/prompt-segments.ts");
const { isValidSegmentPath } = await import("../src/core/prompt-segments.ts");
const { promptOverrides } = await import("../src/store/prompt-overrides.ts");
const { PUT: putSettingsSection } = await import("../server/routes/settings/[section]/route.ts");
const { DELETE: deletePromptText } = await import("../server/routes/settings/prompts/[...segment]/route.ts");
const { readSettingsRecord } = await import("../src/server/index.ts");

/** The REAL repo prompts dir this suite must never touch (read-only). */
const REPO_PROMPTS = path.resolve(import.meta.dirname, "../data/prompts");

/** Read-only recursive snapshot of a dir (sorted "rel|size" lines). */
function snapshotDir(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (rel: string) => {
		for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(child);
			else out.push(`${child}|${fs.statSync(path.join(dir, child)).size}`);
		}
	};
	walk("");
	return out;
}
const REAL_PROMPTS_BEFORE = snapshotDir(REPO_PROMPTS);

after(() => {
	assert.ok(PROMPTS_OVERRIDE_DIR.startsWith(TMP_DATA), "every write this suite makes lands under the LH_DATA_DIR seam");
	assert.deepEqual(snapshotDir(REPO_PROMPTS), REAL_PROMPTS_BEFORE, "real data/prompts survives npm test byte-for-byte");
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

/** PUT /api/settings/<section> with a fabricated params context. */
function putSection(section: string, body: unknown): Promise<Response> {
	return putSettingsSection(
		new Request(`http://test/api/settings/${section}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ section }) },
	);
}

/** DELETE /api/settings/prompts/<segment...> with a fabricated params context. */
function deleteSegment(segment: string[]): Promise<Response> {
	return deletePromptText(new Request("http://test/api/settings/prompts", { method: "DELETE" }), {
		params: Promise.resolve({ segment }),
	});
}

const sourceTextOf = (segment: string) =>
	effectivePromptSegments(segment.startsWith("prober/") ? "prober" : "teacher", {}).find((s) => s.path === segment)!.sourceText;

describe("isValidSegmentPath (the mirror-layout discipline)", () => {
	it("accepts the shared base and numeric fragments, rejects everything else", () => {
		for (const good of ["system-prompt.md", "teacher/20-teaching.md", "prober/10-probe-doctrine.md", "shared/10-personality.md"]) {
			assert.equal(isValidSegmentPath(good), true, good);
		}
		for (const bad of [
			"", // empty
			"README.md", // no agent dir
			"teacher/README.md", // not numeric-prefixed
			"teacher/20-teaching.txt", // not .md
			"../system-prompt.md", // traversal
			"agent/../teacher/20-teaching.md", // traversal
			"/etc/passwd", // absolute
			"teacher", // bare dir
			"teacher/", // bare dir
			"teacher/sub/10-x.md", // nested (not the mirror layout)
			"prober\\10-x.md", // backslash
		]) {
			assert.equal(isValidSegmentPath(bad), false, bad);
		}
	});
});

describe("the override store", () => {
	it("lists written mirrors sorted; read round-trips; delete is idempotent; invalid paths never reach disk", () => {
		fs.rmSync(PROMPTS_OVERRIDE_DIR, { recursive: true, force: true });
		assert.deepEqual(promptOverrides.listOverrides(), []);
		promptOverrides.writeOverride("teacher/20-teaching.md", "custom teaching");
		promptOverrides.writeOverride("system-prompt.md", "custom base");
		assert.deepEqual(promptOverrides.listOverrides(), ["system-prompt.md", "teacher/20-teaching.md"]);
		assert.equal(promptOverrides.readOverride("system-prompt.md"), "custom base");
		promptOverrides.deleteOverride("system-prompt.md");
		promptOverrides.deleteOverride("teacher/20-teaching.md");
		assert.equal(promptOverrides.readOverride("system-prompt.md"), null);
		promptOverrides.deleteOverride("system-prompt.md"); // again: no throw
		promptOverrides.writeOverride("../evil.md", "nope");
		assert.equal(fs.existsSync(path.join(PROMPTS_OVERRIDE_DIR, "..", "evil.md")), false);
	});
});

describe("the source-derived segment list", () => {
	it("mirrors composeInstructions' discovery: shared base first, own fragments, shared appendix, per agent", () => {
		const prober = effectivePromptSegments("prober", {});
		const teacher = effectivePromptSegments("teacher", {});
		for (const [own, other, list] of [["prober/", "teacher/", prober], ["teacher/", "prober/", teacher]] as const) {
			assert.equal(list[0]?.path, "system-prompt.md");
			assert.equal(list[0].shared, true);
			assert.ok(list[0].sourceText.length > 0, "base prompt text loads");
			const paths = list.map((s) => s.path);
			const firstShared = paths.findIndex((p) => p.startsWith("shared/"));
			assert.ok(paths.slice(1, firstShared).every((p) => p.startsWith(own)), "own fragments precede the shared appendix");
			assert.ok(paths.slice(firstShared).every((p) => p.startsWith("shared/")));
			assert.deepEqual(paths.slice(1), [...paths.slice(1, firstShared)].sort().concat([...paths.slice(firstShared)].sort()), "numeric order");
			assert.equal(paths.some((p) => p.startsWith(other)), false);
			assert.ok(list.filter((s) => s.path.startsWith("shared/")).every((s) => s.shared));
		}
		assert.equal(allSegmentPaths().some((p) => p.includes("README")), false, "non-numeric files never load");
	});

	it("effective segments: switch+file → override; either missing → source text", () => {
		promptOverrides.writeOverride("teacher/20-teaching.md", "MY WAY");
		promptOverrides.writeOverride("system-prompt.md", "custom base");
		try {
			const teacher = effectivePromptSegments("teacher", { "teacher/20-teaching.md": true, "teacher/10-planning.md": true });
			const byPath = (p: string) => teacher.find((s) => s.path === p)!;
			assert.equal(byPath("teacher/20-teaching.md").overrideText, "MY WAY");
			assert.equal(byPath("teacher/20-teaching.md").enabled, true);
			// file exists but no switch → source default (files alone never enable)
			assert.equal(byPath("system-prompt.md").overrideText, "custom base");
			assert.equal(byPath("system-prompt.md").enabled, false);
			// a switch for a segment with NO override file never enables it
			assert.equal(byPath("teacher/10-planning.md").overrideText, null);
			assert.equal(byPath("teacher/10-planning.md").enabled, false);
		} finally {
			promptOverrides.deleteOverride("teacher/20-teaching.md");
			promptOverrides.deleteOverride("system-prompt.md");
		}
	});
});

describe("composeInstructions: override honoring + the byte-identical source path", () => {
	const { composeInstructions, createTeacherAgent } = teacherAgent;

	it("switches-less composition is byte-identical to the plain loader", () => {
		// base + the agent's own fragments + the shared/ appendix, trimmed,
		// empties dropped, joined with the separator.
		const oldLoader = (kind: "prober" | "teacher") => {
			const fragmentsOf = (dir: string) =>
				fs
					.readdirSync(dir)
					.filter((f) => /^\d+-[\w.-]+\.md$/.test(f))
					.sort()
					.map((f) => fs.readFileSync(path.join(dir, f), "utf-8").trim())
					.filter(Boolean);
			const base = fs.readFileSync("src/agent/system-prompt.md", "utf-8").trim();
			return [base, ...fragmentsOf(`src/agent/prompts/${kind}`), ...fragmentsOf("src/agent/prompts/shared")].join("\n\n---\n\n");
		};
		assert.equal(composeInstructions("teacher"), oldLoader("teacher"));
		assert.equal(composeInstructions("prober"), oldLoader("prober"));
	});

	it("an enabled override swaps in; switch off or file absent composes source", () => {
		const source = sourceTextOf("teacher/20-teaching.md").trim();
		promptOverrides.writeOverride("teacher/20-teaching.md", "CUSTOM TEACHING LOOP");
		try {
			const on = composeInstructions("teacher", { "teacher/20-teaching.md": true });
			assert.ok(on.includes("CUSTOM TEACHING LOOP"));
			assert.ok(!on.includes(source), "source text is replaced");
			assert.equal(composeInstructions("teacher", {}), composeInstructions("teacher"), "switch off → source");
			assert.equal(composeInstructions("teacher", { "teacher/10-planning.md": true }), composeInstructions("teacher"), "file absent → source");
		} finally {
			promptOverrides.deleteOverride("teacher/20-teaching.md");
		}
	});

	it("shared/ fragments are overridable — one edit swaps the doctrine in BOTH agents", () => {
		const source = sourceTextOf("shared/30-learner-files.md").trim();
		promptOverrides.writeOverride("shared/30-learner-files.md", "MY SHARED FILES DOCTRINE");
		try {
			for (const kind of ["teacher", "prober"] as const) {
				const composed = composeInstructions(kind, { "shared/30-learner-files.md": true });
				assert.ok(composed.includes("MY SHARED FILES DOCTRINE"), `${kind} composes the override`);
				assert.ok(!composed.includes(source), `${kind} source fragment is replaced`);
			}
		} finally {
			promptOverrides.deleteOverride("shared/30-learner-files.md");
		}
	});

	it("promptSwitches threads through agent construction into the system prompt", () => {
		promptOverrides.writeOverride("system-prompt.md", "TOTALLY CUSTOM BASE");
		try {
			const faux = createFauxCore({});
			const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
			const agent = createTeacherAgent(undefined, { engine, promptSwitches: { "system-prompt.md": true } });
			assert.ok(agent.state.systemPrompt.includes("TOTALLY CUSTOM BASE"));
			const source = createTeacherAgent(undefined, { engine });
			assert.ok(!source.state.systemPrompt.includes("TOTALLY CUSTOM BASE"), "no switches → cached source");
		} finally {
			promptOverrides.deleteOverride("system-prompt.md");
		}
	});
});

// ─── the orphan-heal contract (interlude, 2026-09-26) ────────────────────────
// The orphan-400 trap: an ON switch whose file dies orphaned the record;
// every agent-section write then 400'd while the disabled toggle couldn't
// reach the OFF escape hatch. Fix: the delete route clears the switch by
// construction, AND the write path heals any orphan that still arises.

describe("delete clears the switch — the record and file agree by construction", () => {
	const SEGMENT = "teacher/20-teaching.md";

	it("DELETE removes the file AND clears the on-switch in one operation", async () => {
		promptOverrides.writeOverride(SEGMENT, "custom teaching");
		const on = await putSection("agent", { prompts: { [SEGMENT]: true } });
		assert.equal(on.status, 200, "ON with a real file is valid");
		assert.equal(readSettingsRecord()?.agent?.prompts?.[SEGMENT], true);

		const res = await deleteSegment(["teacher", "20-teaching.md"]);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { path: SEGMENT, deleted: true, switchCleared: true });
		assert.equal(readSettingsRecord()?.agent?.prompts?.[SEGMENT], undefined, "the switch is GONE from the record");
		assert.equal(promptOverrides.readOverride(SEGMENT), null, "the file is gone");

		const followUp = await putSection("agent", { tools: { research: false } });
		assert.equal(followUp.status, 200, "a subsequent agent write succeeds");
	});

	it("DELETE is idempotent for file and switch — nothing to clear, still 200", async () => {
		const res = await deleteSegment(["teacher", "20-teaching.md"]);
		assert.equal(res.status, 200);
		assert.equal(((await res.json()) as { switchCleared: boolean }).switchCleared, false);
	});
});

describe("an orphaned ON heals to OFF on write — never a 400 (a user can never get stuck)", () => {
	const SEGMENT = "teacher/20-teaching.md";

	it("file wiped at disk level → the client mirrors the orphan with a tool toggle → the write SUCCEEDS and heals", async () => {
		promptOverrides.writeOverride(SEGMENT, "custom teaching");
		assert.equal((await putSection("agent", { prompts: { [SEGMENT]: true } })).status, 200);
		fs.rmSync(path.join(PROMPTS_OVERRIDE_DIR, "teacher", "20-teaching.md"));

		for (let attempt = 0; attempt < 2; attempt++) {
			const res = await putSection("agent", { tools: { research: false }, prompts: { [SEGMENT]: true } });
			assert.equal(res.status, 200, "the write heals instead of 400-ing");
		}
		const record = readSettingsRecord();
		assert.equal(record?.agent?.prompts?.[SEGMENT], undefined, "the orphaned ON landed as OFF (key dropped)");
		assert.equal(record?.agent?.tools?.research, false, "the rest of the write landed");
	});

	it("an ON for a segment that left the source tree heals the same way", async () => {
		promptOverrides.writeOverride(SEGMENT, "custom teaching");
		try {
			const on = await putSection("agent", { prompts: { "teacher/99-vanished.md": true, [SEGMENT]: true } });
			assert.equal(on.status, 200);
			assert.equal(readSettingsRecord()?.agent?.prompts?.["teacher/99-vanished.md"], undefined);
			assert.equal(readSettingsRecord()?.agent?.prompts?.[SEGMENT], true, "a real ON+file keeps the switch on");
		} finally {
			promptOverrides.deleteOverride(SEGMENT);
		}
	});
});
