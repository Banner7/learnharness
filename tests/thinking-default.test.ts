/**
 * The default-order resolution, client-side: the UI populates a fresh
 * model pick's thinking level with the SAME level the engine build runs
 * for an unset record — the first DEFAULT_THINKING_ORDER entry the model
 * supports (the server's defaultThinkingLevel semantics, src/agent/models.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_THINKING_ORDER } from "../src/core/settings.ts";
import { defaultOrderLevel, populateLevel } from "../components/thinking-default.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const tl = (levels: string[]) => levels as ThinkingLevel[];

describe("defaultOrderLevel — the ordering's first supported", () => {
	it("picks the first order entry the model supports; off for non-reasoning or empty support", () => {
		assert.equal(defaultOrderLevel(tl(["off", "minimal", "low", "medium", "high", "xhigh", "max"])), DEFAULT_THINKING_ORDER[0]);
		assert.equal(defaultOrderLevel(tl(["minimal", "low", "medium", "high"])), "medium");
		assert.equal(defaultOrderLevel(tl(["minimal", "low", "high"])), "low");
		assert.equal(defaultOrderLevel(tl(["high", "xhigh", "max"])), "high");
		assert.equal(defaultOrderLevel(tl(["off"])), "off");
		assert.equal(defaultOrderLevel(tl([])), "off");
	});
});

describe("populateLevel — an explicit pick always rides; absence populates", () => {
	it("explicit levels ride even when unsupported (the write clamps server-side); absence populates the order's level", () => {
		assert.equal(populateLevel("high", tl(["low", "high"])), "high");
		assert.equal(populateLevel("xhigh", tl(["minimal", "medium", "high"])), "xhigh");
		assert.equal(populateLevel(undefined, tl(["low", "high"])), "low");
	});
});
