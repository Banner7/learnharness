import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActivitySection, formatElapsed, toBlobs, type ActivityFeed, type FeedExtraction } from "../components/activity-dock.tsx";
import { formatTokens, formatUsd } from "../components/usage-format.ts";
import { jobCost } from "../src/server/pricing.ts";

// The background-agents section: folds, money/context accounting, blob order,
// then the SSR render.

const NOW = Date.parse("2026-09-09T12:00:00Z");

function job(over: Partial<ActivityFeed["jobs"][number]> = {}): ActivityFeed["jobs"][number] {
	return {
		id: "job-1",
		kind: "research",
		chatId: "c1",
		toolCallId: "t1",
		status: "running",
		activity: 'web_search: "sigma.js v3"',
		createdAt: new Date(NOW - 45_000).toISOString(),
		updatedAt: new Date(NOW - 1000).toISOString(),
		title: "Limits lesson",
		contextLimit: null,
		costUsd: jobCost({ usage: over.usage }),
		...over,
	};
}

const usage = (over: Partial<Record<"inputTokens" | "outputTokens" | "cacheReadTokens" | "steps", number>> = {}) => ({
	model: "openrouter:z-ai/glm-5.3-flash",
	inputTokens: 10_000,
	outputTokens: 1000,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	reasoningTokens: 0,
	steps: 1,
	...over,
});

const blobOf = (j: ActivityFeed["jobs"][number]) => toBlobs({ jobs: [j], extractions: [] })[0]!;

describe("activity dock pure layer", () => {
	it("merges jobs + extractions oldest-first; per-chunk rows keep unique ids and one source chatId", () => {
		const blobs = toBlobs({
			jobs: [job({ id: "new", createdAt: new Date(NOW - 10_000).toISOString() })],
			extractions: [{ id: "cx", chatId: "cx", title: "Old lesson", phase: "auditing", startedAt: NOW - 100_000 }],
		});
		assert.deepEqual(blobs.map((b) => b.id), ["cx", "new"], "the extraction started first");
		assert.equal(blobs[0]!.process, "extraction");
		assert.equal(blobs[0]!.phase, "auditing");
		assert.equal(blobs[0]!.cost, null, "extractions carry no money");
		assert.equal(blobs[0]!.context, null);
		const chunks = toBlobs({ jobs: [], extractions: [
			{ id: "src_a#1", chatId: "src_a", part: { i: 1, n: 2 }, title: "notes.md · 1/2", phase: "extracting", startedAt: NOW - 1000 },
			{ id: "src_a#2", chatId: "src_a", part: { i: 2, n: 2 }, title: "notes.md · 2/2", phase: "queued", startedAt: NOW - 500 },
		] as FeedExtraction[] });
		assert.deepEqual(chunks.map((b) => b.id), ["src_a#1", "src_a#2"]);
		assert.ok(chunks.every((b) => b.chatId === "src_a"));
	});

	it("uses the server's price projection; absent pricing is null, never zero", () => {
		const priced = job({ usage: usage({ cacheReadTokens: 5000, steps: 2 }) });
		assert.equal(blobOf(priced).cost, 0.00215);
		assert.equal(blobOf({ ...priced, costUsd: undefined }).cost, null, "the browser must not invent a fallback price");
		assert.equal(blobOf(job()).cost, null);
	});

	it("configuration refusals read as info; a real failure stays 'failed'", () => {
		const errored = (error: string) => blobOf(job({ status: "error", activity: "failed", error })).activity;
		assert.equal(errored("No OpenRouter credential is configured — configure it on the server"), "needs a provider key");
		assert.equal(errored("No model configured — set up your models first (missing: vision)"), "needs model setup");
		assert.equal(errored("FAILED: headless crashed"), "failed");
	});

	it("context line = LAST step's cache-inclusive tokens vs the feed's limit, never a cumulative sum", () => {
		const base = usage({ inputTokens: 400_000, outputTokens: 8_000, steps: 5 });
		const lastStep = { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 120_000, cacheWriteTokens: 30_000, reasoningTokens: undefined };
		const cached = blobOf(job({ usage: { ...base, lastStep }, contextLimit: 200_000 }));
		assert.equal(cached.context?.used, 160_500);
		assert.equal(cached.context?.limit, 200_000);
		assert.equal(blobOf(job({ usage: { ...base } })).context, null, "no lastStep yet → no line");
		assert.equal(blobOf(job({ usage: { ...base, model: "nope/unknown", lastStep } })).context, null, "uncatalogued model → no line");
	});

	it("formats elapsed time, dollars, and tokens compactly", () => {
		assert.deepEqual([45_000, 184_000, 4_320_000].map(formatElapsed), ["45s", "3m 04s", "1h 12m"]);
		assert.deepEqual([0.0014, 1.5].map(formatUsd), ["$0.0014", "$1.50"]);
		assert.deepEqual([38_000, 1_234_567, 950].map(formatTokens), ["38k", "1.2M", "950"]);
	});
});

describe("activity section render", () => {
	it("idle: the section renders with no rows and no total", () => {
		const html = renderToStaticMarkup(<ActivitySection feed={{ jobs: [], extractions: [] }} />);
		assert.match(html, /data-testid="activity-section"/);
		assert.doesNotMatch(html, /activity-blob-(job|extraction)|activity-total-cost/);
	});

	it("one blob per process with the abort affordance; unpriced shows —, priced jobs sum in the header", () => {
		const html = renderToStaticMarkup(<ActivitySection feed={{
			jobs: [job({ id: "j1", kind: "demo", activity: "building sandbox…", title: "Chain-rule demo" })],
			extractions: [{ id: "cx", chatId: "cx", title: "Old lesson", phase: "merging", startedAt: NOW - 60_000 }],
		}} />);
		assert.match(html, /data-testid="activity-blob-job"/);
		assert.match(html, /data-testid="activity-blob-extraction"/);
		assert.match(html, /data-testid="activity-abort"/);
		assert.match(html, /activity-total-cost[^>]*>—</, "never $0.0000 when nothing is priced");
		const priced = renderToStaticMarkup(<ActivitySection feed={{
			jobs: [job({ id: "a", usage: usage() }), job({ id: "b", usage: usage(), createdAt: new Date(NOW - 20_000).toISOString() })],
			extractions: [],
		}} />);
		assert.match(priced, /activity-total-cost[^>]*>\$0\.0040</);
	});
});
