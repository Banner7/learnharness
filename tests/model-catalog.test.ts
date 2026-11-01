import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
const testData = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cli-catalog-data-"));
process.env.LH_DATA_DIR = testData;
after(() => fs.rmSync(testData, { recursive: true, force: true }));
const {
	catalogContextLimits,
	catalogDefaultsFor,
	catalogProviders,
	catalogSlots,
	clampChatLevel,
	clampModelsLevels,
	modelCatalog,
	rolePinsFor,
	validateChatSettings,
	validateModelsSettings,
} = await import("../src/server/model-catalog.ts");
import type { EffectiveSlot } from "../src/core/settings-resolution.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
import { BACKGROUND_MODEL_ROLES } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { SETTINGS_FILE } = await import("../config.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");

// The model-control wave (2026-09-12): pi-ai owns the registry — these pins
// hold our projection + validation honest against the shipped catalog, and
// pin pi's per-model thinking truth so a pi-ai upgrade can't silently change
// what we send. BYOK wave (2026-09-22): no factory pins — unset surfaces
// are NULL/undefined, never phantom defaults.

// The picker federates only providers with a PRESENT key (model slots
// wave, 2026-09-20): pin openrouter's env key so its full catalog
// federates in tests regardless of the developer shell's exports.
process.env.OPENROUTER_API_KEY ??= "test-key-openrouter-catalog";

/** A reasoning specimen whose supported set differs from glm's. */
function qwenModel() {
	const qwen = piModels().getModel("openrouter", "qwen/qwen3.8-max-0902");
	assert.ok(qwen, "qwen3.8-max in catalog");
	return qwen!;
}

describe("the model catalog projection", () => {
	it("federates only keyed providers; keyless providers are listed for discovery only", () => {
		const { models, providers, slots } = modelCatalog();
		assert.ok(models.length > 300, `expected a full catalog, got ${models.length}`);
		assert.deepEqual(models.find((m) => m.id === "z-ai/glm-5.3-flash")?.supportedLevels, ["low", "high", "max"]);
		assert.ok(providers.find((p) => p.id === "openrouter")?.keyPresent, "openrouter federated (key pinned above)");
		const keyless = providers.filter((p) => !p.keyPresent).map((p) => p.id);
		assert.ok(keyless.length > 0, "keyless providers listed for discovery");
		for (const id of keyless) {
			assert.ok(!models.some((m) => m.provider === id), `keyless ${id} must not federate`);
		}
		assert.deepEqual(Object.keys(slots), ["strong", "cheap", "vision"]);
	});

	it("defaults: the strong slot verbatim; null when unset (BYOK, per-session models 2026-09-28)", () => {
		assert.equal(catalogDefaultsFor(null), null);
		const strong = { provider: "openrouter", id: "z-ai/glm-5.3-flash", thinkingLevel: "low" as const };
		const d = catalogDefaultsFor(strong);
		assert.deepEqual(d, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "low" });
		// No level stored → the model alone reports (the level resolves at
		// engine build from DEFAULT_THINKING_ORDER).
		const bare = catalogDefaultsFor({ provider: "openrouter", id: "qwen/qwen3.8-flash" });
		assert.deepEqual(bare, { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } });
	});
});

describe("the background roles' resolved pins (rolePins)", () => {
	it("no record → every role is NULL (BYOK: no phantom defaults)", () => {
		const pins = rolePinsFor(resolveSettings(null).agent.models);
		assert.deepEqual(Object.keys(pins), [...BACKGROUND_MODEL_ROLES]);
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.equal(pins[role], null, role);
		}
	});

	it("a slot re-tiers its roles; overrides win for that role only", () => {
		const record = {
			version: 1,
			models: { cheap: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } } },
			agent: { models: { researcher: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" as const } } },
		};
		const pins = rolePinsFor(resolveSettings(record).agent.models);
		assert.deepEqual(pins.researcher, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" });
		assert.deepEqual(pins.auditor, { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } }); // level unset
		assert.equal(pins.visualMaker, null, "vision tier untouched");
	});
});

describe("the model slots surface (model slots wave, 2026-09-20)", () => {
	it("catalogSlots projects the record's tiers — NULL only where a tier holds no model", () => {
		// machine-aware (one-fs-owner: READ the record, never pin it)
		const record = readSettings();
		const slots = catalogSlots();
		for (const name of ["strong", "cheap", "vision"] as const) {
			const stored = record?.models?.[name];
			if (stored?.model) {
				assert.ok(slots[name], name);
				assert.deepEqual(slots[name]!.model, stored.model);
			} else {
				assert.equal(slots[name], null, name);
			}
		}
	});

	it("catalogProviders reads keys env-wins, fresh per call", () => {
		const before = catalogProviders().find((p) => p.id === "zai");
		assert.equal(before?.keyPresent, false);
		const saved = process.env.ZAI_API_KEY;
		process.env.ZAI_API_KEY = "test-zai-key-1234567890";
		try {
			assert.equal(catalogProviders().find((p) => p.id === "zai")?.keyPresent, true);
		} finally {
			if (saved === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = saved;
		}
	});
});

describe("the models-section validation gate", () => {
	it("accepts a valid slot and rejects unknown provider/model", () => {
		assert.equal(validateModelsSettings({ strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } } }).ok, true);
		assert.equal(validateModelsSettings({ cheap: { model: { provider: "nope", id: "x" } } }).ok, false);
		assert.equal(validateModelsSettings({ vision: { model: { provider: "openrouter", id: "nope/nope" } } }).ok, false);
	});

	it("thinking levels never reject a slot write; empty clears (owner, interlude 2026-09-22)", () => {
		// clamp, never reject: validation accepts ANY level; the WRITE clamps.
		assert.deepEqual(validateModelsSettings({ strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "minimal" } }), { ok: true });
		assert.deepEqual(validateModelsSettings({}), { ok: true });
	});

	it("clampModelsLevels: the slot's own model translates the pin (the owner's exact case)", () => {
		// Claude Fable 5.1 xhigh → GLM 5.3 flash: the pin clamps to glm's
		// nearest supported (low|high|max) and the CLAMPED value is stored.
		const glm = { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "xhigh" as const };
		assert.deepEqual(clampModelsLevels({ strong: glm }), {
			strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "max" },
		});
		assert.deepEqual(clampModelsLevels({ strong: { ...glm, thinkingLevel: "minimal" as const } }).strong, {
			model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
			thinkingLevel: "low",
		});
		// glm cannot disable thinking: off clamps UP to low
		assert.equal(
			clampModelsLevels({ strong: { ...glm, thinkingLevel: "off" as const } }).strong?.thinkingLevel,
			"low",
		);
		// a supported level passes through untouched
		assert.deepEqual(clampModelsLevels({ strong: { ...glm, thinkingLevel: "high" as const } }).strong, {
			model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
			thinkingLevel: "high",
		});
		// a slot with no level rides as-is (client populates on fresh
		// picks per DEFAULT_THINKING_ORDER — the server never invents one)
		assert.deepEqual(clampModelsLevels({ strong: { model: glm.model } }), {
			strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } },
		});
	});
});

describe("the settings validation gate", () => {
	it("thinking levels never reject a chat write; empty clears (owner, interlude 2026-09-22)", () => {
		assert.deepEqual(validateChatSettings({ model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "minimal" }), { ok: true });
		assert.deepEqual(validateChatSettings({ thinkingLevel: "xhigh" }), { ok: true });
		assert.deepEqual(validateChatSettings({}), { ok: true });
	});

	it("clampChatLevel: the body's model, else the strong slot, translates the pin", () => {
		const glm = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
		const strong: EffectiveSlot = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
		// the body's own model wins
		assert.deepEqual(
			clampChatLevel({ model: { provider: "openrouter", id: "qwen/qwen3.8-max-0902" }, thinkingLevel: "xhigh" as const }, strong),
			{ model: { provider: "openrouter", id: "qwen/qwen3.8-max-0902" }, thinkingLevel: clampThinkingLevel(qwenModel(), "xhigh") },
		);
		// no body model → the record's strong slot is the fallback
		assert.equal(clampChatLevel({ thinkingLevel: "xhigh" as const }, strong).thinkingLevel, "max");
		// no model anywhere → rides unchecked (runtime clamps; the turn
		// gate refuses the model-less chat anyway)
		assert.deepEqual(clampChatLevel({ thinkingLevel: "minimal" as const }, null), { thinkingLevel: "minimal" });
		// no pinned level → untouched
		assert.deepEqual(clampChatLevel({ model: { ...glm } }, strong), { model: { ...glm } });
	});

	it("rejects unknown providers and models", () => {
		assert.equal(validateChatSettings({ model: { provider: "nope", id: "x/y" } }).ok, false);
		assert.equal(validateChatSettings({ model: { provider: "openrouter", id: "nope/nope" } }).ok, false);
	});
});

describe("the engine factory's thinking levels", () => {
	it("the engine factory clamps explicit levels; unknown models throw honestly", () => {
		const over = piEngineForSpec({ provider: "openrouter", id: "qwen/qwen3.8-flash", thinkingLevel: "high" });
		assert.equal(over.model.id, "qwen/qwen3.8-flash");
		assert.equal(over.level, "high");
		const clamped = piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinkingLevel: "minimal" });
		assert.equal(clamped.level, "low");
		assert.throws(() => piEngineForSpec({ provider: "openrouter", id: "nope/nope", thinkingLevel: "low" }), /catalog has no model/);
	});

	it("UNSET levels resolve from DEFAULT_THINKING_ORDER; explicit levels never consult it", () => {
		// glm supports low|high|max → first supported in the order is "low"
		assert.equal(piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash" }).level, "low");
		assert.equal(piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash", thinkingLevel: "max" }).level, "max");
		// a non-reasoning model reports exactly ["off"] → the order lands there
		const flat = piModels()
			.getProviders()
			.flatMap((p) => piModels().getModels(p.id))
			.find((m) => !m.reasoning);
		if (flat) {
			assert.deepEqual(getSupportedThinkingLevels(flat), ["off"]);
			assert.equal(piEngineForSpec({ provider: flat.provider, id: flat.id }).level, "off");
		}
	});
});
/** Runs fn with PATH and HOME pointed at a temp dir, so the CLI lookup only
 *  finds a claude binary when installed is true. */
function withClaudeInstalled(installed: boolean, fn: () => void, enabled = true): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-catalog-"));
	const saved = { PATH: process.env.PATH, HOME: process.env.HOME, npm_config_prefix: process.env.npm_config_prefix };
	const settings = readSettings();
	writeSettings({ ...(settings ?? { version: 1 }), claudeCode: { enabled } });

	if (installed) fs.writeFileSync(path.join(dir, "claude"), "#!/bin/sh\n", { mode: 0o755 });
	process.env.PATH = dir;
	process.env.HOME = dir;
	delete process.env.npm_config_prefix;

	try {
		fn();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		if (settings) writeSettings(settings);
		else fs.rmSync(SETTINGS_FILE, { force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("the claude-code provider (native CLI authentication, no LearnHarness key)", () => {
	it("claude-code lists opus/sonnet/haiku when the CLI is installed, and hides when it is missing", () => {
		withClaudeInstalled(true, () => {
			assert.deepEqual(modelCatalog().models.filter((m) => m.provider === "claude-code").map((m) => m.id), ["haiku", "opus", "sonnet"]);
			assert.deepEqual(catalogProviders().find((p) => p.id === "claude-code"), { id: "claude-code", envVar: "", keyPresent: true });
			assert.equal(catalogContextLimits().has("claude-code:opus"), false, "never advertises placeholder CLI limits");
		});
		withClaudeInstalled(false, () => {
			assert.equal(catalogProviders().find((p) => p.id === "claude-code")?.keyPresent, false);
			assert.equal(modelCatalog().models.some((m) => m.provider === "claude-code"), false);
		});
	});

	it('piEngineForSpec({ provider: "claude-code", id: "sonnet" }) resolves', () => {
		const engine = piEngineForSpec({ provider: "claude-code", id: "sonnet" });
		assert.equal(engine.model.provider, "claude-code");
		assert.equal(engine.model.id, "sonnet");
	});

	it('providerKeyPresent("claude-code") requires both explicit opt-in and executable presence', () => {
		withClaudeInstalled(true, () => assert.equal(providerKeyPresent("claude-code"), true));
		withClaudeInstalled(false, () => assert.equal(providerKeyPresent("claude-code"), false));
		withClaudeInstalled(true, () => {
			assert.equal(providerKeyPresent("claude-code"), false);
			assert.equal(catalogProviders().find((p) => p.id === "claude-code")?.keyPresent, false);
			assert(!modelCatalog().models.some((m) => m.provider === "claude-code"));
			assert.equal(validateChatSettings({ model: { provider: "claude-code", id: "sonnet" } }).ok, false);
		}, false);
	});
});
