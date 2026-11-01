import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CoverageMenuBody,
	CoverageRingDetail,
	fetchGraphRead,
	ringFill,
	type SessionCoverage,
} from "../components/extraction-coverage.tsx";

/**
 * The extraction-coverage surfaces: the sidebar context-menu block and the
 * chat top bar's ring meter. The live fetch chains are Playwright's beat.
 */

function coverage(over: Partial<SessionCoverage> = {}): SessionCoverage {
	return {
		totalMessages: 12,
		coveredCount: 7,
		uncoveredCount: 5,
		coveredTokens: 30_000,
		uncoveredTokens: 2_048,
		running: false,
		lastFoldedAt: null,
		...over,
	};
}

describe("fetchGraphRead — one truth with the extraction trigger (2026-10-02)", () => {
	// The meter's denominator MUST be the number the server's effectiveSettings
	// gate waits for — the factory the core resolver serves, never a
	// hand-rolled constant (owner repro: 6k shown full at a stale `?? 4096`).
	const read = async (payload: unknown, ok = true) => {
		const real = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: ok ? 200 : 500 })) as typeof fetch;
		try {
			return await fetchGraphRead();
		} finally {
			globalThis.fetch = real;
		}
	};

	it("an unset budget (no graph section, no key, null settings) is the factory 4096; a custom one rides through", async () => {
		for (const settings of [{ version: 1 }, { version: 1, graph: { enabled: true } }, null]) {
			assert.deepEqual(await read({ settings }), { enabled: true, chunkTokens: 4096 }, JSON.stringify(settings));
		}
		assert.equal((await read({ settings: { version: 1, graph: { enabled: true, extractionChunkTokens: 2000 } } }))?.chunkTokens, 2000);
	});

	it("fetch failure → null → no ring", async () => {
		assert.equal(await read({}, false), null);
	});
});

describe("ringFill (the donut's fold, pure)", () => {
	it("fills uncovered/chunk, clamped to [0,1]; a non-positive threshold reads zero", () => {
		assert.equal(ringFill(0, 4096), 0);
		assert.equal(ringFill(2048, 4096), 0.5);
		assert.equal(ringFill(999_999, 4096), 1, "past the threshold reads full, never >1");
		assert.equal(ringFill(2048, 0), 0);
		assert.equal(ringFill(2048, -5), 0);
	});
});

describe("CoverageMenuBody — the Extract affordance", () => {
	const html = (over: Partial<SessionCoverage>, extracting = false) =>
		renderToStaticMarkup(<CoverageMenuBody coverage={coverage(over)} extracting={extracting} onExtract={() => {}} />);

	it("an uncovered session can extract; fully extracted, running, or click-pending cannot", () => {
		assert.ok(!html({}).includes('disabled=""'));
		assert.ok(html({ uncoveredTokens: 0, uncoveredCount: 0 }).includes('disabled=""'), "nothing to run");
		assert.ok(html({ running: true }).includes('disabled=""'), "no double-fire");
		const optimistic = html({}, true);
		assert.ok(optimistic.includes('data-testid="ctx-coverage-running"'), "the optimistic state shows at once");
		assert.ok(optimistic.includes('disabled=""'));
	});
});

describe("CoverageRingDetail — the popover's exact numbers", () => {
	it("carries covered/uncovered tokens, messages, the threshold", () => {
		const html = renderToStaticMarkup(<CoverageRingDetail coverage={coverage({ lastFoldedAt: "2026-09-24T10:00:00Z" })} chunkTokens={4096} />);
		assert.match(html, /Uncovered.*2k tokens/s);
		assert.match(html, /Covered.*30k tokens/s);
		assert.match(html, /7 \/ 12/);
		assert.match(html, /Chunk threshold.*4\.1k tokens/s);
	});
});
