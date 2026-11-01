/**
 * Tests for the resolution layer (settings-storage wave, 2026-09-19;
 * model-slots wave 2026-09-20; BYOK all-the-way-down wave 2026-09-22):
 * core/settings-resolution.ts — the delta→concrete projection. There are
 * NO factory pins anymore: a model chain that ends empty resolves to
 * null/undefined, and the per-need refusal gates (turn, job spawn,
 * extraction) fire on exactly that.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractionEnabled,
	graphToolsEnabled,
	resolveConversationSpec,
	resolveModelSpec,
	resolveRoleSpec,
	resolveSettings,
	resolveSlot,
} from "../src/core/settings-resolution.ts";
import { BACKGROUND_MODEL_ROLES, type UserSettings } from "../src/core/settings.ts";

describe("resolveSettings", () => {
	it("null record (first boot): every model view is EMPTY — no phantom ids anywhere", () => {
		const eff = resolveSettings(null);
		assert.deepEqual(eff.agent.tools, {});
		assert.deepEqual(eff.agent.prompts, {});
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.equal(eff.agent.models[role], undefined, role);
		}
		assert.equal(eff.models.strong, null);
		assert.equal(eff.models.cheap, null);
		assert.equal(eff.models.vision, null);
	});

	it("explicit record values win over every factory default", () => {
		const record: UserSettings = {
			version: 1,
			agent: {
				models: { researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } } },
				tools: { research: false },
				prompts: { "system-prompt.md": true },
				search: { engine: "tavily" },
			},
			appearance: { proseFontSize: 20, mdRendering: { headingWeight: 600 } },
			graph: { enabled: false },
		};
		const eff = resolveSettings(record);
		// thinking NOT overridden and no cheap slot → UNSET (the engine
		// build resolves it from DEFAULT_THINKING_ORDER, not a pin).
		assert.deepEqual(eff.agent.models.researcher, { provider: "openrouter", id: "qwen/qwen3.8-flash", thinkingLevel: undefined });
		assert.deepEqual(eff.agent.search, { engine: "tavily" });
		assert.deepEqual(eff.agent.tools, { research: false });
		assert.deepEqual(eff.agent.prompts, { "system-prompt.md": true });
		assert.equal(eff.appearance.proseFontSize, 20);
		assert.equal(eff.appearance.mdRendering.headingWeight, 600);
		assert.equal(eff.graph.enabled, false);
		assert.equal(resolveSettings({ version: 1, graph: { extractionChunkTokens: 2000 } }).graph.extractionChunkTokens, 2000);
	});

	it("partial role override: thinkingLevel alone borrows the SLOT's model (or nothing, without one)", () => {
		const eff = resolveSettings({
			version: 1,
			models: { cheap: { model: { provider: "zai", id: "glm-5.3-flash" } } },
			agent: { models: { extractor: { thinkingLevel: "medium" } } },
		});
		assert.deepEqual(eff.agent.models.extractor, { provider: "zai", id: "glm-5.3-flash", thinkingLevel: "medium" });
		const bare = resolveSettings({ version: 1, agent: { models: { extractor: { thinkingLevel: "medium" } } } });
		assert.equal(bare.agent.models.extractor, undefined); // no model anywhere → chain empty
	});

	it("resolveModelSpec is field-independent per override aspect", () => {
		const slots = { cheap: { model: { provider: "zai", id: "slot-model" }, thinkingLevel: "high" as const } };
		assert.deepEqual(resolveModelSpec("auditor", { model: { provider: "other", id: "x" } }, slots), { provider: "other", id: "x", thinkingLevel: "high" });
		assert.deepEqual(resolveModelSpec("auditor", { thinkingLevel: "max" }, slots), { provider: "zai", id: "slot-model", thinkingLevel: "max" });
		assert.equal(resolveModelSpec("auditor", undefined, {}), undefined);
	});
});

describe("the slot tier (BYOK, owner 2026-09-22)", () => {
	it("slot alone re-tiers every role of its tier; other tiers stay empty", () => {
		const eff = resolveSettings({ version: 1, models: { cheap: { model: { provider: "zai", id: "glm-5.3-flash" } } } });
		for (const role of ["researcher", "demoBuilder", "extractor", "auditor"] as const) {
			assert.deepEqual(eff.agent.models[role], { provider: "zai", id: "glm-5.3-flash", thinkingLevel: undefined }, role);
		}
		assert.equal(eff.agent.models.visualMaker, undefined);
	});

	it("role override still beats the slot; each field independent", () => {
		const eff = resolveSettings({
			version: 1,
			agent: { models: { researcher: { model: { provider: "groq", id: "r-override" } } } },
			models: { cheap: { model: { provider: "zai", id: "r-slot" }, thinkingLevel: "high" } },
		});
		assert.deepEqual(eff.agent.models.researcher, { provider: "groq", id: "r-override", thinkingLevel: "high" });
		assert.deepEqual(eff.agent.models.auditor, { provider: "zai", id: "r-slot", thinkingLevel: "high" });
	});

	it("vision slot covers visualMaker AND pdfReader; level-only slots resolve as NULL", () => {
		const vision: UserSettings = { version: 1, models: { vision: { model: { provider: "zai", id: "v-model" }, thinkingLevel: "max" } } };
		const spec = { provider: "zai", id: "v-model", thinkingLevel: "max" };
		assert.deepEqual(resolveSettings(vision).agent.models.visualMaker, spec);
		assert.deepEqual(resolveSettings(vision).models.vision, spec);
		assert.deepEqual(resolveRoleSpec("pdfReader", vision), spec);
		// a stored level WITHOUT a model is inert (kept on disk, no phantom default)
		const inert = resolveSettings({ version: 1, models: { strong: { thinkingLevel: "medium" } } });
		assert.equal(inert.models.strong, null);
		assert.equal(inert.agent.models.researcher, undefined);
		assert.equal(resolveSlot({ thinkingLevel: "medium" }), null);
		assert.equal(resolveSlot(undefined), null);
	});

	it("resolveRoleSpec: background roles and the conversation pair share the chain", () => {
		const record: UserSettings = { version: 1, models: { strong: { model: { provider: "zai", id: "strong-model" } } } };
		assert.deepEqual(resolveRoleSpec("prober", record), { provider: "zai", id: "strong-model", thinkingLevel: undefined });
		const withOverride: UserSettings = { ...record, agent: { models: { researcher: { model: { provider: "groq", id: "r" } } } } };
		assert.deepEqual(resolveRoleSpec("researcher", withOverride), { provider: "groq", id: "r", thinkingLevel: undefined });
		assert.equal(resolveRoleSpec("teacher", null), undefined);
	});
});

describe("resolveConversationSpec (the turn gate's chain)", () => {
	it("chat.model over the strong slot; null when both empty", () => {
		assert.equal(resolveConversationSpec(undefined, null), null);
		assert.deepEqual(resolveConversationSpec(undefined, { provider: "zai", id: "s" }), { provider: "zai", id: "s", thinkingLevel: undefined });
		assert.deepEqual(resolveConversationSpec({ model: { provider: "groq", id: "c" } }, { provider: "zai", id: "s", thinkingLevel: "low" }), {
			provider: "groq",
			id: "c",
			thinkingLevel: "low",
		});
	});

	it("bare chat thinking level rides the strong slot's model; a chat-only level rides alone", () => {
		assert.deepEqual(
			resolveConversationSpec({ thinkingLevel: "high" }, { provider: "zai", id: "s", thinkingLevel: "low" }),
			{ provider: "zai", id: "s", thinkingLevel: "high" },
		);
		assert.deepEqual(
			resolveConversationSpec({ model: { provider: "groq", id: "c" }, thinkingLevel: "max" }, null),
			{ provider: "groq", id: "c", thinkingLevel: "max" },
		);
	});
});

describe("the graph channel gates", () => {
	it("extraction dies with the master switch, through resolveSettings", () => {
		assert.equal(extractionEnabled(resolveSettings(null).graph), true);
		assert.equal(extractionEnabled(resolveSettings({ version: 1, graph: { enabled: false } }).graph), false);
	});

	it("PROBER GRAPH TOOLS gate (wave 7): the agent toggle AND the graph master switch compose", () => {
		const graph = { enabled: true };
		assert.equal(graphToolsEnabled({ graph, agent: resolveSettings(null).agent }), true, "absent subsection = ON");
		assert.equal(graphToolsEnabled({ graph, agent: { graphTools: { enabled: false } } }), false);
		assert.equal(graphToolsEnabled({ graph: { enabled: false }, agent: { graphTools: { enabled: true } } }), false, "graph off kills the tools regardless of the toggle");
		assert.deepEqual(resolveSettings({ version: 1, agent: { graphTools: { enabled: false } } }).agent.graphTools, { enabled: false });
	});
});
