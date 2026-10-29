/**
 * Pure reading-typography mappings and settings compose helpers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appearanceVars, resolveAppearance } from "../components/settings/appearance.tsx";
import {
	PROMPT_IN_USE_HINT,
	composePromptSwitch,
	composeSearchEngine,
	composeSlotModel,
	composeTool,
	composeQuizMechanics,
	sectionedSegments,
} from "../components/settings/agent-section.tsx";
import type { AgentSettings, ModelsSettings } from "../src/core";
import { slotsConfigured } from "../src/core";

describe("resolveAppearance — delta over factory", () => {
	it("absent everything = the factory view", () => {
		const a = resolveAppearance(undefined);
		assert.equal(a.proseFontSize, 17);
		assert.deepEqual(a.mdRendering, { headingWeight: 700 });
	});

	it("explicit deltas win field-by-field", () => {
		const a = resolveAppearance({ proseFontSize: 20, mdRendering: { headingWeight: 600 } });
		assert.equal(a.proseFontSize, 20);
		assert.equal(a.mdRendering.headingWeight, 600);
	});
});

describe("appearanceVars — the mapping the provider applies", () => {
	it("factory appearance sets only size and heading weight", () => {
		const vars = appearanceVars(resolveAppearance(undefined));
		assert.deepEqual(vars, {
			"--lh-prose-size": "17px",
			"--lh-heading-weight": "700",
		});
	});

	it("a delta changes the corresponding tokens, not the bundled fonts", () => {
		const vars = appearanceVars(resolveAppearance({
			proseFontSize: 18,
			mdRendering: { headingWeight: 600 },
		}));
		assert.deepEqual(vars, {
			"--lh-prose-size": "18px",
			"--lh-heading-weight": "600",
		});
	});
});

describe("agent section compose helpers — the replace-whole PUT body", () => {
	it("composeTool carries the rest of the section verbatim", () => {
		const before = { tools: { demo: false }, prompts: { "system-prompt.md": true } };
		const after = composeTool(before, "visual", false);
		assert.deepEqual(after.tools, { demo: false, visual: false });
		assert.deepEqual(after.prompts, { "system-prompt.md": true }, "prompts untouched");
	});

	it("composeSlotModel: empty+empty REMOVES the slot (absent = factory pin)", () => {
		const after = composeSlotModel(
			{ strong: { model: { provider: "openrouter", id: "x" } }, cheap: {} },
			"strong",
			"",
			"",
			"",
		);
		assert.equal(after.strong, undefined, "slot dropped");
		assert.deepEqual(after.cheap, {}, "sibling untouched");
	});

	it("composeSlotModel: model alone, thinking alone, and both — provider rides the swap (federation)", () => {
		assert.deepEqual(composeSlotModel(undefined, "strong", "zai", "glm-4.7-flash", "").strong, {
			model: { provider: "zai", id: "glm-4.7-flash" },
		});
		assert.deepEqual(composeSlotModel(undefined, "cheap", "", "", "low").cheap, { thinkingLevel: "low" });
		assert.deepEqual(composeSlotModel(undefined, "vision", "openai", "gpt-5.2", "high").vision, {
			model: { provider: "openai", id: "gpt-5.2" },
			thinkingLevel: "high",
		});
	});

	it("composeSlotModel: per-field independence — clearing the model keeps the thinking pin", () => {
		const prev: ModelsSettings = { strong: { model: { provider: "zai", id: "glm-4.7-flash" }, thinkingLevel: "high" } };
		const after = composeSlotModel(prev, "strong", "", "", "high");
		assert.deepEqual(after.strong, { model: { provider: "zai", id: "glm-4.7-flash" }, thinkingLevel: "high" }, "model carried, thinking kept");
		// clearing thinking keeps the model
		const after2 = composeSlotModel(prev, "strong", "zai", "glm-4.7-flash", "");
		assert.deepEqual(after2.strong, { model: { provider: "zai", id: "glm-4.7-flash" } }, "thinking dropped, model kept");
	});

	it("composeSearchEngine: null REMOVES the pin (auto-activation's resting state)", () => {
		const withPin: AgentSettings = { search: { engine: "tavily" } };
		const cleared = composeSearchEngine(withPin, null);
		assert.equal(cleared.search, undefined);
		// no pin to begin with → carried verbatim
		assert.deepEqual(composeSearchEngine({ tools: { demo: true } }, null).tools, { demo: true });
	});

	it("composeSearchEngine: the explicit preference writes agent.search.engine", () => {
		assert.deepEqual(composeSearchEngine(undefined, "brave").search, { engine: "brave" });
	});

	it("composePromptSwitch: on = explicit true, off = key REMOVED (absent = off)", () => {
		assert.deepEqual(composePromptSwitch({ prompts: { a: true } }, "b", true).prompts, { a: true, b: true });
		assert.deepEqual(composePromptSwitch({ prompts: { a: true, b: true } }, "b", false).prompts, { a: true });
	});
});


describe("model configuration gate — slotsConfigured", () => {
	it("slotsConfigured: all three slot models required — thinking levels are optional", () => {
		assert.equal(slotsConfigured(undefined), false, "no record = unconfigured");
		assert.equal(slotsConfigured({}), false, "empty models section");
		assert.equal(
			slotsConfigured({
				strong: { model: { provider: "zai", id: "glm-5.3-flash" } },
				cheap: { model: { provider: "zai", id: "glm-4.7-flash" } },
			}),
			false,
			"vision missing",
		);
		assert.equal(
			slotsConfigured({
				strong: { model: { provider: "zai", id: "glm-5.3-flash" } },
				cheap: { model: { provider: "zai", id: "glm-4.7-flash" } },
				vision: { model: { provider: "openai", id: "gpt-5.2" } },
			}),
			true,
			"all three picked",
		);
		// a thinking-only pin does NOT configure the slot
		assert.equal(
			slotsConfigured({ strong: { thinkingLevel: "low" }, cheap: { thinkingLevel: "low" }, vision: { thinkingLevel: "low" } }),
			false,
			"thinking pins are not models",
		);
	});

});

describe("sectionedSegments — the prompts overhaul (2026-09-26)", () => {
	// The server contract: BOTH per-agent lists include the shared
	// segments (same paths) — the view must list them ONCE.
	const view = {
		prober: [
			{ path: "system-prompt.md", sourceText: "b", overrideText: null, enabled: false, shared: true },
			{ path: "shared/10-personality.md", sourceText: "s1", overrideText: "custom", enabled: true, shared: true },
			{ path: "prober/10-probe-doctrine.md", sourceText: "p1", overrideText: null, enabled: false, shared: false },
		],
		teacher: [
			{ path: "system-prompt.md", sourceText: "b", overrideText: null, enabled: false, shared: true },
			{ path: "shared/10-personality.md", sourceText: "s1", overrideText: "custom", enabled: true, shared: true },
			{ path: "teacher/05-method.md", sourceText: "t1", overrideText: null, enabled: false, shared: false },
			{ path: "teacher/10-planning.md", sourceText: "t2", overrideText: null, enabled: false, shared: false },
		],
	};

	it("the owner's ruled order: Teacher, Prober, Shared — Shared last", () => {
		const ids = sectionedSegments(view).map((s) => s.id);
		assert.deepEqual(ids, ["teacher", "prober", "shared"]);
	});

	it("shared chunks appear exactly ONCE across all sections (no duplication)", () => {
		const all = sectionedSegments(view).flatMap((s) => s.segments.map((seg) => seg.path));
		assert.equal(all.filter((p) => p === "system-prompt.md").length, 1);
		assert.equal(all.filter((p) => p === "shared/10-personality.md").length, 1);
		// every path unique — no chunk listed twice
		assert.equal(new Set(all).size, all.length);
	});

	it("the Shared section holds the shared chunks in assembly order; the agents' sections hold their own", () => {
		const [teacher, prober, shared] = sectionedSegments(view);
		assert.ok(teacher && prober && shared, "all three sections present");
		assert.deepEqual(teacher.segments.map((s) => s.path), ["teacher/05-method.md", "teacher/10-planning.md"]);
		assert.deepEqual(prober.segments.map((s) => s.path), ["prober/10-probe-doctrine.md"]);
		// assembly order: the base file first, then the shared fragments
		assert.deepEqual(shared.segments.map((s) => s.path), ["system-prompt.md", "shared/10-personality.md"]);
		// the Shared header carries the one hint that earns its place
		assert.equal(shared.hint, "Used by both agents");
		assert.equal(teacher.hint, undefined);
	});

	it("the indicator copy is pinned — it states WHICH VERSION IS IN USE (refined 2026-09-26)", () => {
		assert.equal(PROMPT_IN_USE_HINT, "Your version is in use");
	});
});

// ─── the quizzing-mechanics segmented control (owner 2026-09-27) ───────────

describe("composeQuizMechanics (the segmented control's write)", () => {
	it("free recall writes explain:true; multiple choice writes explain:false — nothing else moves", () => {
		const before: AgentSettings = { tools: { research: false }, prompts: { teacher: true } } as AgentSettings;
		const free = composeQuizMechanics(before, "free");
		assert.equal(free.tools?.explain, true);
		const choice = composeQuizMechanics(before, "choice");
		assert.equal(choice.tools?.explain, false);
		for (const after of [free, choice]) {
			assert.equal(after.tools?.research, false, "the research toggle carries verbatim");
			assert.deepEqual(after.prompts, before.prompts, "the prompts map carries verbatim");
		}
	});
});
