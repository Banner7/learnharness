import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatsBar, formatContextMeasurement } from "../components/stats-bar.tsx";
import { sessionCost } from "../src/server/pricing.ts";
import { catalogLimits } from "../components/model-picker.tsx";
import type { ModelCatalogEntry } from "../src/core/contracts.ts";
import { prettyModel } from "../components/usage-format.ts";
import type { TurnUsage } from "../src/core/contracts.ts";

// The stats bar: folds only (no cost math in the component), the "—"
// doctrine for absent data, and honest cost (never a fake $0).

function turn(over: Partial<TurnUsage> = {}): TurnUsage {
	return {
		id: "t1",
		messageId: "m1",
		at: "2026-09-09T12:00:00Z",
		model: "openrouter:z-ai/glm-5.3-flash",
		steps: [{ inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined }],
		...over,
	};
}

describe("stats bar", () => {
	it("no turns yet → no context or cost figures", () => {
		const html = renderToStaticMarkup(<StatsBar turns={[]} />);
		assert.ok(!html.includes('data-testid="stats-cost"'), "no cost figure pre-chat");
	});

	it("folds context + cost from the turns log (core/prices, no local math)", () => {
		const html = renderToStaticMarkup(
			<StatsBar turns={[turn(), turn()]} contextTokens={11_000} pricing={sessionCost({ turns: [turn(), turn()] })} />,
		);
		// No catalog index in a static render → usage-only meter, never a fallback window.
		assert.match(html, /data-testid="stats-context">11k</);
		// pi catalog price 0.15/0.5 per 1M: each turn 10k×0.15 + 1k×0.5 = $0.002 → two = $0.0040
		assert.match(html, /data-testid="stats-cost">\$0\.0040</);
	});

	it("shows — for cost when every turn is unpriceable, never a fake $0", () => {
		const unknown = [turn({ model: "nope/unknown" })];
		const html = renderToStaticMarkup(<StatsBar turns={unknown} contextTokens={11_000} pricing={sessionCost({ turns: unknown })} />);
		assert.match(html, /data-testid="stats-cost">—</);
		assert.match(html, /data-testid="stats-context">11k</, "real usage still reads, usage-only");
	});

	it("unknown context is explicit; changing the selected limit preserves the measurement", () => {
		assert.equal(formatContextMeasurement(null, 100_000), "? / 100k");
		assert.equal(formatContextMeasurement(83_000, 100_000), "83k / 100k");
		assert.equal(formatContextMeasurement(83_000, 200_000), "83k / 200k");
		assert.equal(formatContextMeasurement(83_000, null), "83k");
		assert.match(renderToStaticMarkup(<StatsBar chatId="fixture" turns={[turn()]} contextTokens={null} />), /data-testid="stats-context">\?</);
	});

	it("prettyModel strips only the vendor path; qualified stamps add the provider suffix", () => {
		for (const [stamp, qualified, expected] of [
			["z-ai/glm-5.3-flash", false, "glm-5.3-flash"],
			["google/gemma-4-27b-it:free", false, "gemma-4-27b-it:free"],
			["claude-opus-5-5", false, "claude-opus-5-5"],
			["model:variant:free", false, "model:variant:free"],
			["openrouter:z-ai/glm-5.3-flash", true, "glm-5.3-flash · openrouter"],
			["openrouter:google/gemma-4-27b-it:free", true, "gemma-4-27b-it:free · openrouter"],
			// bare ids are never parsed as usage stamps; no suffix invented
			["z-ai/glm-5.3-flash", true, "glm-5.3-flash"],
		] as const) {
			assert.equal(prettyModel(stamp, qualified), expected, stamp);
		}
	});
});

describe("catalogLimits (the stats-bar live-limits join, pure)", () => {
	it("keys provider:id → contextWindow; missing models are absent (never a fallback)", () => {
		const entry = (id: string, provider: string, contextWindow: number): ModelCatalogEntry => ({
			id, provider, contextWindow, name: id, reasoning: false, input: ["text"], supportedLevels: [],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, maxTokens: 32_768,
		});
		const limits = catalogLimits({
			models: [
				entry("z-ai/glm-5.3-flash", "openrouter", 1_048_576),
				entry("z-ai/glm-5.3-flash", "zai", 200_000),
				entry("gpt-x", "openai", 400_000),
			],
		});
		assert.equal(limits.get("openrouter:z-ai/glm-5.3-flash"), 1_048_576);
		assert.equal(limits.get("zai:z-ai/glm-5.3-flash"), 200_000, "same model on different providers keys apart");
		assert.equal(limits.get("openai:gpt-x"), 400_000);
		assert.equal(limits.has("nope/unknown"), false);
	});
});
