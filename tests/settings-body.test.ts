/**
 * Tests for the section parsers (settings-storage wave, 2026-09-19):
 * src/server/settings-body.ts. Every known field is strict (bad type/shape
 * → 400-style error, never a silent clamp), unknown keys drop, absent
 * fields mean absent overrides. Pure — no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseAgentSettingsBody,
	parseModelsSettingsBody,
	parseAppearanceSettingsBody,
	parseCompactionSettingsBody,
	parseGraphSettingsBody,
} from "../src/server/settings-body.ts";

describe("parseAgentSettingsBody", () => {
	it("models: valid roles with model pair and/or thinkingLevel; unknown role and malformed pairs are 400s", () => {
		const r = parseAgentSettingsBody({
			models: {
				researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } },
				auditor: { thinkingLevel: "high" },
			},
		});
		assert.ok(r.ok);
		assert.deepEqual(r.settings.models, {
			researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } },
			auditor: { thinkingLevel: "high" },
		});
		assert.equal(parseAgentSettingsBody({ models: { teacher: {} } }).ok, false);
		assert.equal(parseAgentSettingsBody({ models: { researcher: { model: { provider: 1, id: "x" } } } }).ok, false);
	});

	it("tools and prompts: boolean maps; non-boolean values are 400s", () => {
		const r = parseAgentSettingsBody({ tools: { research: false }, prompts: { "system-prompt.md": true } });
		assert.ok(r.ok);
		assert.deepEqual(r.settings.tools, { research: false });
		assert.deepEqual(r.settings.prompts, { "system-prompt.md": true });
		assert.equal(parseAgentSettingsBody({ tools: { quiz: "no" } }).ok, false);
		assert.equal(parseAgentSettingsBody({ prompts: { "x.md": 1 } }).ok, false);
	});

	it("search: engine pin is tavily|brave; {} clears to auto-detect; anything else is a 400", () => {
		const ok = parseAgentSettingsBody({ search: { engine: "tavily" } });
		assert.ok(ok.ok);
		assert.deepEqual(ok.settings.search, { engine: "tavily" });
		const clear = parseAgentSettingsBody({ search: {} });
		assert.ok(clear.ok);
		assert.equal(clear.settings.search, undefined);
		for (const search of [{ engine: "google" }, "tavily", { engine: 1 }]) {
			assert.equal(parseAgentSettingsBody({ search }).ok, false, JSON.stringify(search));
		}
	});

	it("graphTools: strict object subsection, enabled boolean when present", () => {
		const off = parseAgentSettingsBody({ graphTools: { enabled: false } });
		assert.ok(off.ok);
		assert.deepEqual(off.settings.graphTools, { enabled: false });
		for (const graphTools of ["off", { enabled: "yes" }, null]) {
			assert.equal(parseAgentSettingsBody({ graphTools }).ok, false, JSON.stringify(graphTools));
		}
	});
});

describe("parseAppearanceSettingsBody", () => {
	it("parses typography fields and drops retired font settings", () => {
		const r = parseAppearanceSettingsBody({ fontFamily: "Georgia", sessionNameSerif: false, proseFontSize: 20, mdRendering: { headingWeight: 700 } });
		assert.ok(r.ok);
		assert.deepEqual(r.settings, { proseFontSize: 20, mdRendering: { headingWeight: 700 } });
	});

	it("rejects bad types and ranges (never clamps); boundaries pass", () => {
		for (const body of [{ proseFontSize: 30 }, { proseFontSize: 64.5 }, { mdRendering: { headingWeight: 1000 } }, [1], { mdRendering: "big" }]) {
			assert.equal(parseAppearanceSettingsBody(body).ok, false, JSON.stringify(body));
		}
		for (const body of [{ proseFontSize: 12 }, { proseFontSize: 24 }, { mdRendering: { headingWeight: 100 } }, { mdRendering: { headingWeight: 900 } }]) {
			assert.equal(parseAppearanceSettingsBody(body).ok, true, JSON.stringify(body));
		}
	});
});

describe("parseGraphSettingsBody", () => {
	it("parses the master switch replace-whole; dead wave-6 rungs are ignored; junk is a 400", () => {
		const r = parseGraphSettingsBody({ enabled: false, clustering: true, labeling: true });
		assert.ok(r.ok);
		assert.deepEqual(r.settings, { enabled: false });
		assert.equal(parseGraphSettingsBody({}).ok, true);
		assert.equal(parseGraphSettingsBody({ enabled: "off" }).ok, false);
		assert.equal(parseGraphSettingsBody("nope").ok, false);
	});

	it("extractionChunkTokens: whole tokens ≥ the 500 floor (extraction-UX redesign, 2026-09-24)", () => {
		const ok = parseGraphSettingsBody({ enabled: true, extractionChunkTokens: 2048 });
		assert.ok(ok.ok);
		assert.deepEqual(ok.settings, { enabled: true, extractionChunkTokens: 2048 });
		const fraction = parseGraphSettingsBody({ extractionChunkTokens: 1024.9 });
		assert.ok(fraction.ok);
		assert.equal(fraction.settings.extractionChunkTokens, 1024, "fractions floor to whole tokens");
		for (const extractionChunkTokens of [100, "4096", NaN, null]) {
			assert.equal(parseGraphSettingsBody({ extractionChunkTokens }).ok, false, String(extractionChunkTokens));
		}
	});
});

describe("parseCompactionSettingsBody (owner round 14)", () => {
	it("parses and floors a threshold; {} is the empty section; below 32k and non-numbers are 400s", () => {
		const r = parseCompactionSettingsBody({ thresholdTokens: 120000.9 });
		assert.ok(r.ok);
		assert.deepEqual(r.settings, { thresholdTokens: 120000 });
		const none = parseCompactionSettingsBody({});
		assert.ok(none.ok);
		assert.deepEqual(none.settings, {});
		assert.equal(parseCompactionSettingsBody({ thresholdTokens: 20_000 }).ok, false);
		assert.equal(parseCompactionSettingsBody({ thresholdTokens: "big" }).ok, false);
	});
});

describe("parseModelsSettingsBody (model slots wave, 2026-09-20)", () => {
	it("parses the three slot tiers — model required, level rides (BYOK, owner 2026-09-22)", () => {
		const slots = {
			strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } },
			cheap: { model: { provider: "zai", id: "glm-5.3-flash" }, thinkingLevel: "high" },
			vision: { model: { provider: "zai", id: "glm-5.3-flash" }, thinkingLevel: "low" },
		};
		const r = parseModelsSettingsBody(slots);
		assert.ok(r.ok);
		assert.deepEqual(r.settings, slots);
		const cleared = parseModelsSettingsBody({});
		assert.ok(cleared.ok);
		assert.deepEqual(cleared.settings, {}, "{} is the legal clear-slots write");
	});

	it("a slot without a model, unknown slots, and malformed shapes are 400s", () => {
		const bodies: unknown[] = [
			{ cheap: { thinkingLevel: "high" } }, // a level WITHOUT a model can never run
			{ strong: {} },
			{ mega: { thinkingLevel: "high" } },
			{ cheap: { model: { provider: "x" } } },
			{ vision: { thinkingLevel: 7 } },
			"nope",
		];
		for (const body of bodies) {
			assert.equal(parseModelsSettingsBody(body).ok, false, JSON.stringify(body));
		}
	});
});
