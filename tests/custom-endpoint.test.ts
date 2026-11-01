/**
 * The custom OpenAI-compatible endpoint: the pure core (normalizeBaseUrl,
 * customProviderUsable, the sanitizer, resolution) and the provider build
 * with its precedence rules (user pin > endpoint metadata > compiled default).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
	CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
	customProviderUsable,
	normalizeBaseUrl,
	parseModelIds,
	sanitizeCustomModelOverrides,
	sanitizeUserSettings,
} from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { CUSTOM_PROVIDER } from "../src/core/auth-keys.ts";
import { buildOpenAiCompatibleProvider } from "../src/server/custom-provider.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

describe("custom endpoint core", () => {
	it("normalizeBaseUrl trims and drops trailing slashes; non-http(s) and junk become empty", () => {
		assert.equal(normalizeBaseUrl("  https://host:8000/v1/  "), "https://host:8000/v1");
		assert.equal(normalizeBaseUrl("http://localhost:11434"), "http://localhost:11434");
		for (const bad of ["file:///etc/passwd", "not a url", ""]) assert.equal(normalizeBaseUrl(bad), "");
	});

	it("customProviderUsable is true exactly when a base URL is set (the key is optional)", () => {
		assert.equal(customProviderUsable({ baseUrl: "https://h/v1" }), true);
		for (const cp of [{ baseUrl: "" }, {}, undefined]) assert.equal(customProviderUsable(cp), false);
	});

	it("parseModelIds splits on commas/whitespace, trims, dedupes, and ignores junk", () => {
		assert.deepEqual(parseModelIds(" doubao-seed-2.1-pro, kimi-k3.1-pro\nqwen/qwen3-max ,, kimi-k3.1-pro "), ["doubao-seed-2.1-pro", "kimi-k3.1-pro", "qwen/qwen3-max"]);
		assert.deepEqual(parseModelIds(["a", " b ", "", 3, null, "a"]), ["a", "b"]);
		assert.deepEqual(parseModelIds({ id: "a" }), []);
	});
});

describe("sanitizeUserSettings — customProvider", () => {
	it("normalizes the base URL and cleans models, pins, and manual ids", () => {
		const cp = sanitizeUserSettings({
			customProvider: {
				baseUrl: "https://host:8000/v1/",
				models: [
					{ id: " llama-3 " },
					{ id: "gpt", image: true },
					{ id: "gpt", image: false }, // dup id: last wins → image dropped
					{ id: "thinker", reasoning: true },
					{ id: "plain", reasoning: "yes" },
					{ id: "" },
					"not-an-object",
				],
				overrides: {
					llama: { context: 131072, maxTokens: 8192, reasoning: true },
					qwen: { context: 10 },
					quiet: { reasoning: false },
					junk: { context: "big", maxTokens: -1, reasoning: "yes" },
					" ": { context: 4096 },
					nope: "not-an-object",
				},
				manualModels: [" a ", "a", "b"],
			},
		})?.customProvider;
		assert.equal(cp?.baseUrl, "https://host:8000/v1");
		assert.deepEqual(cp?.models, [{ id: "llama-3" }, { id: "gpt" }, { id: "thinker", reasoning: true }, { id: "plain" }]);
		assert.deepEqual(cp?.overrides, {
			llama: { context: 131072, maxTokens: 8192, reasoning: true },
			qwen: { context: 10 },
			quiet: { reasoning: false },
		});
		assert.deepEqual(cp?.manualModels, ["a", "b"]);
	});

	it("drops invalid base URL, non-array models, non-object overrides, and empty manual lists", () => {
		const cp = sanitizeUserSettings({ customProvider: { baseUrl: "ftp://x", models: "nope", overrides: "nope", manualModels: [] } })?.customProvider;
		assert.equal(cp?.baseUrl, undefined);
		assert.equal(cp?.models, undefined);
		assert.equal(cp?.overrides, undefined);
		assert.equal(cp?.manualModels, undefined);
	});

	it("prunes pins only against a supplied live-id list", () => {
		const pins = { a: { context: 32768 }, b: { context: 32768 } };
		assert.deepEqual(Object.keys(sanitizeCustomModelOverrides(pins, ["a"])), ["a"]);
		assert.deepEqual(Object.keys(sanitizeCustomModelOverrides(pins)), ["a", "b"]);
		assert.deepEqual(sanitizeCustomModelOverrides("nope"), {});
	});

	it("resolveSettings fills defaults and carries stored pins and manual ids", () => {
		assert.deepEqual(resolveSettings(null).customProvider, { baseUrl: "", models: [], overrides: {}, manualModels: [] });
		const resolved = resolveSettings({
			version: 1,
			customProvider: { baseUrl: "http://h/v1", models: [{ id: "a" }], overrides: { a: { context: 32768 } }, manualModels: ["a"] },
		});
		assert.deepEqual(resolved.customProvider.overrides, { a: { context: 32768 } });
		assert.deepEqual(resolved.customProvider.manualModels, ["a"]);
	});
});

describe("buildOpenAiCompatibleProvider", () => {
	it("maps ids to openai-completions models; image-capable models accept image input", () => {
		const provider = buildOpenAiCompatibleProvider({ baseUrl: "http://h/v1", models: [{ id: "m1" }, { id: "m2", image: true }] });
		assert.equal(provider.id, CUSTOM_PROVIDER.id);
		const [m1, m2] = provider.getModels();
		assert.equal(m1!.api, "openai-completions");
		assert.equal(m1!.provider, CUSTOM_PROVIDER.id);
		assert.equal(m1!.baseUrl, "http://h/v1");
		assert.deepEqual(m1!.input, ["text"]);
		assert.deepEqual(m2!.input, ["text", "image"]);
	});

	it("token limits: a user pin beats the endpoint, which beats the compiled default", () => {
		const provider = buildOpenAiCompatibleProvider({
			baseUrl: "http://h/v1",
			models: [{ id: "pinned", context: 32768, maxTokens: 4096 }, { id: "detected", context: 65536 }, { id: "bare" }],
			overrides: { pinned: { context: 131072, maxTokens: 16384 } },
		});
		const [pinned, detected, bare] = provider.getModels();
		assert.equal(pinned!.contextWindow, 131072);
		assert.equal(pinned!.maxTokens, 16384);
		assert.equal(detected!.contextWindow, 65536);
		assert.equal(detected!.maxTokens, CUSTOM_MODEL_DEFAULT_MAX_TOKENS);
		assert.equal(bare!.contextWindow, CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW);
	});

	it("reasoning: the tri-state pin beats endpoint detection; reasoning models get the standard levels", () => {
		const provider = buildOpenAiCompatibleProvider({
			baseUrl: "http://h/v1",
			models: [{ id: "liar", reasoning: true }, { id: "silent" }, { id: "thinker", reasoning: true }, { id: "plain" }],
			overrides: { liar: { reasoning: false }, silent: { reasoning: true } },
		});
		const levels = Object.fromEntries(provider.getModels().map((m) => [m.id, getSupportedThinkingLevels(m)]));
		const standard = ["off", "minimal", "low", "medium", "high"];
		assert.deepEqual(levels, { liar: ["off"], silent: standard, thinker: standard, plain: ["off"] });
	});
});
