import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activeCompactionOf,
	estimateContextTokens,
	estimateMessageTokens,
	compactionCutIndex,
	estimateTokens,
	keptIndexFor,
	newCompactionMarker,
	newUserMessage,
	serializeForSummary,
	toLlmMessages,
	COMPACTED_HISTORY_HEADER,
	type LhMessage,
	type LhMarkerMessage,
} from "../src/core/index.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { projectView } from "../src/core/view.ts";

// Compaction core laws (owner round 14, 2026-10-05): the cut never separates a
// tool result from its call; a pending question survives; the newest marker
// rules and renders once; a corrupt cut degrades to full history.

const assistantWithCall = (id: string, callId: string, text = "Let me quiz you."): LhMessage =>
	({
		id,
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: callId, name: "quiz", arguments: { question: "Q?" } },
		],
		timestamp: 1,
	}) as never;

const assistantText = (id: string, text: string): LhMessage =>
	({ id, role: "assistant", content: [{ type: "text", text }], timestamp: 1 }) as never;

const resultFor = (callId: string, text: string): LhMessage & ToolResultMessage =>
	({
		id: `r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: "quiz",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	}) as never;

const big = (id: string, kb = 8): LhMessage => newUserMessage(`${id}: ${"x".repeat(kb * 1024)}`);

describe("estimateContextTokens (usage-anchored, pi's law)", () => {
	const usageAssistant = (id: string, total: number, trailing = false): LhMessage =>
		({
			id,
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage: { input: total - 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: trailing ? "aborted" : "toolUse",
			timestamp: 1,
		}) as never;

	it("anchors on the last assistant's provider-reported usage and chars/4-estimates ONLY the tail", () => {
		const msgs = [
			newUserMessage(`${"x".repeat(400_000)}`), // 100k chars of DROPPED-span text
			usageAssistant("a1", 30_000),
			newUserMessage("y".repeat(4_000)), // 1k estimated tokens AFTER the anchor
		] as LhMessage[];
		const est = estimateContextTokens(msgs);
		assert.equal(est.lastUsageIndex !== null, true);
		assert.equal(est.usageTokens, 30_000);
		assert.equal(est.trailingTokens, 1_000);
		assert.equal(est.tokens, 31_000); // the 100k chars before the anchor are NOT re-estimated
	});

	it("skips aborted and all-zero-usage assistants when hunting the anchor", () => {
		const msgs = [
			usageAssistant("a1", 30_000),
			usageAssistant("a2", 99_999, true), // aborted after the real one
			{ ...usageAssistant("a3", 0), stopReason: "toolUse" }, // zero usage
		] as LhMessage[];
		const est = estimateContextTokens(msgs);
		assert.equal(est.lastUsageIndex, 0);
		assert.equal(est.tokens, 30_000 + estimateMessageTokens(msgs[1]!) + estimateMessageTokens(msgs[2]!));
	});

	it("refuses anchors older than the newest compaction marker (pre-cut usage is not truth)", () => {
		const marker = newCompactionMarker("summary text", {
			firstKeptMessageId: "m1",
			tokensBefore: 500_000,
			at: "2026-10-05T00:00:00.000Z",
		});
		const msgs = [usageAssistant("a1", 500_000), marker as LhMessage, newUserMessage("kept tail")] as LhMessage[];
		const est = estimateContextTokens(msgs);
		assert.equal(est.lastUsageIndex, null, "the marker invalidates every anchor behind it");
	});
});

describe("estimateMessageTokens (wire text only — the 3x-inflation fix)", () => {
	it("assistant: text + thinking + toolCall name/args — scaffolding never counted", () => {
		const m = {
			id: "a1",
			role: "assistant",
			content: [
				{ type: "text", text: "x".repeat(400) },
				{ type: "thinking", thinking: "y".repeat(800), thinkingSignature: "sig" },
				{ type: "toolCall", id: "c1", name: "quiz", arguments: { q: "z".repeat(200) } },
			],
			usage: { input: 9_999_999, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 10_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			responseId: "r".repeat(300),
			timestamp: 1,
		} as never as LhMessage;
		const expected = Math.ceil((400 + 800 + ("quiz".length + JSON.stringify({ q: "z".repeat(200) }).length)) / 4);
		assert.equal(estimateMessageTokens(m), expected); // usage/responseId/signature inflate nothing
	});
});

describe("compactionCutIndex", () => {
	it("keeps ~the budget of recent messages: everything before is the span", () => {
		const messages = [big("m1"), big("m2"), big("m3"), big("m4"), newUserMessage("recent")];
		const cut = compactionCutIndex(messages, 4_500);
		assert.equal((messages[cut] as { content: string }).content.startsWith("m2"), true, "overshoot is at most one message");
	});

	it("native cut after an oversized result drops both call and result, never keeps an orphan", () => {
		const messages = [
			big("m1"),
			big("m2"),
			assistantWithCall("a1", "call_1"), // pose
			resultFor("call_1", "correct"), // answer — must ride WITH a1
			big("m3"),
			big("m4"),
		];
		// Budget lands on the result. Pi chooses the next valid cut AT OR
		// AFTER it, dropping the complete exchange rather than extending.
		const cut = compactionCutIndex(messages, estimateTokens([big("m3"), big("m4")]) + 1);
		assert.equal(cut, 4);
		const keptIds = new Set(messages.slice(cut).map((m) => m.id));
		assert.equal(keptIds.has("a1"), false);
		assert.equal(keptIds.has("r_call_1"), false);
	});

	it("a PENDING question call (no result — the pose→answer window) always survives", () => {
		const messages = [big("m1"), big("m2"), big("m3"), assistantWithCall("a_pending", "call_p")];
		const cut = compactionCutIndex(messages, 100); // tiny budget
		const kept = messages.slice(cut);
		assert.ok(kept.some((m) => m.id === "a_pending"), "the pending pose is never dropped");
	});
});

describe("the compaction marker", () => {
	it("activeCompactionOf: the NEWEST marker rules (chained compactions)", () => {
		const old = newCompactionMarker("old", { firstKeptMessageId: "m1", tokensBefore: 1, at: "t" });
		const fresh = newCompactionMarker("fresh", { firstKeptMessageId: "m5", tokensBefore: 2, at: "t" });
		const active = activeCompactionOf([old as never, newUserMessage("x"), fresh as never]);
		assert.equal(active!.content.endsWith("fresh"), true);
	});

	it("a marker with malformed details is not an active compaction (defensive)", () => {
		const broken = { ...newCompactionMarker("s", { firstKeptMessageId: "m1", tokensBefore: 1, at: "t" }), details: {} };
		assert.equal(activeCompactionOf([broken as never]), null);
	});

	it("keptIndexFor: found by id; missing → -1 (the honest-fallback signal)", () => {
		const marker = newCompactionMarker("s", { firstKeptMessageId: "m2", tokensBefore: 1, at: "t" }) as LhMarkerMessage & { details: { firstKeptMessageId: string } };
		const messages = [newUserMessage("a"), newUserMessage("b"), newUserMessage("c")];
		messages[0]!.id = "m1";
		messages[1]!.id = "m2";
		assert.equal(keptIndexFor(messages as never, marker as never), 1);
		const gone = newCompactionMarker("s", { firstKeptMessageId: "zzz", tokensBefore: 1, at: "t" }) as LhMarkerMessage & { details: { firstKeptMessageId: string } };
		assert.equal(keptIndexFor(messages as never, gone as never), -1);
	});
});

describe("toLlmMessages honors the cut", () => {
	it("the active marker renders ONCE as the head; the span before the cut is gone; the kept tail rides verbatim", () => {
		const span = [big("m1"), assistantText("a0", "early lecture")];
		const kept = [newUserMessage("m2"), assistantText("a1", "recent")];
		const marker = newCompactionMarker("SUMMARY TEXT", {
			firstKeptMessageId: kept[0]!.id,
			tokensBefore: 200_000,
			at: "t",
		});
		const out = toLlmMessages([...span, ...kept, marker] as never);
		assert.equal(out.length, 3, "head + two kept messages");
		assert.ok(JSON.stringify(out[0]).includes("SUMMARY TEXT"));
		const flat = JSON.stringify(out);
		assert.ok(!flat.includes("early lecture"), "the pre-cut span never reaches the wire");
	});

	it("omits nine superseded summaries inside the retained tail without changing stored history", () => {
		const kept = newUserMessage("retained exchange");
		const details = { firstKeptMessageId: kept.id, tokensBefore: 200_000, at: "fixture" };
		const old = Array.from({ length: 9 }, (_, i) => newCompactionMarker(`SUPERSEDED-${i}`, details));
		const fresh = newCompactionMarker("LATEST SUMMARY", details);
		const messages = [newUserMessage("discarded"), kept, ...old, newUserMessage("latest reply"), fresh];
		const original = JSON.stringify(messages);
		const out = toLlmMessages(messages);
		const flat = JSON.stringify(out);
		assert.equal(out.length, 3, "latest summary + retained exchange + latest reply");
		assert.ok(flat.includes("LATEST SUMMARY"));
		assert.ok(!flat.includes("SUPERSEDED-"));
		assert.equal(flat.split(COMPACTED_HISTORY_HEADER).length - 1, 1);
		assert.equal(JSON.stringify(messages), original, "projection never rewrites the record");
	});

	it("a pending (dangling) question call in the KEPT tail still gets the interrupted synthesis", () => {
		const kept = [assistantWithCall("a1", "call_1")];
		const marker = newCompactionMarker("S", { firstKeptMessageId: "a1", tokensBefore: 1, at: "t" });
		const out = toLlmMessages([big("m0"), ...kept, marker] as never);
		const synthesis = out.find((m) => (m as never as { toolCallId?: string }).toolCallId === "call_1");
		assert.ok(synthesis, "the dangling kept call is synthesized, not stranded");
	});

	it("an unresolved newest cutoff preserves the full-history fallback, including summary text", () => {
		const kept = newUserMessage("retained exchange");
		const old = newCompactionMarker("OLD SUMMARY", { firstKeptMessageId: kept.id, tokensBefore: 1, at: "fixture" });
		const fresh = newCompactionMarker("LATEST SUMMARY", { firstKeptMessageId: "missing", tokensBefore: 2, at: "fixture" });
		const messages = [newUserMessage("earliest exchange"), kept, old, newUserMessage("latest reply"), fresh];
		const original = JSON.stringify(messages);
		const out = toLlmMessages(messages);
		assert.equal(out.length, messages.length);
		assert.equal(out[0]!.content, "earliest exchange", "do not silently apply the older cutoff");
		const flat = JSON.stringify(out);
		assert.ok(flat.includes("OLD SUMMARY"));
		assert.ok(flat.includes("LATEST SUMMARY"));
		assert.equal(flat.split(COMPACTED_HISTORY_HEADER).length - 1, 2);
		assert.equal(JSON.stringify(messages), original);
	});
});

describe("serializeForSummary", () => {
	it("truncates long tool results; skips plan blocks", () => {
		const long = "y".repeat(5_000);
		const messages: LhMessage[] = [
			newUserMessage("hello"),
			assistantText("a1", "lecture"),
			resultFor("c1", long),
			{ id: "pb", role: "custom", customType: "plan-block", content: "", display: true, details: {}, timestamp: 1 } as never,
		];
		const text = serializeForSummary(messages);
		assert.ok(text.includes("hello") && text.includes("lecture"));
		assert.ok(!text.includes("yyyyy".repeat(1000)), "truncation bounded the result");
		assert.ok(!text.toLowerCase().includes("plan-block"), "UI-only markers never serialize");
	});

	it("preserves legacy summary text when the caller has no separately supplied prior summary", () => {
		const marker = newCompactionMarker("LEGACY SUMMARY", { firstKeptMessageId: "missing", tokensBefore: 1, at: "fixture" });
		assert.ok(serializeForSummary([marker]).includes("LEGACY SUMMARY"));
	});
});

describe("projectView compaction dividers", () => {
	const record = (): LhMessage[] => [
		{ id: "old1", role: "user", content: "earliest", timestamp: 1 },
		{ id: "kept", role: "user", content: "recent", timestamp: 2 },
		newCompactionMarker("SUMMARY TEXT", {
			firstKeptMessageId: "kept",
			tokensBefore: 12345,
			at: new Date(0).toISOString(),
		}) as unknown as LhMessage,
	];

	it("emits the cut divider right BEFORE the first kept message and the moment divider after it", () => {
		const view = projectView(record());
		const keptIdx = view.findIndex((m) => m.parts.some((p) => p.type === "text" && p.text === "recent"));
		const cutIdx = view.findIndex((m) => m.parts.some((p) => p.type === "data-compaction-cut"));
		const momentIdx = view.findIndex((m) => m.parts.some((p) => p.type === "data-compaction"));
		assert.ok(keptIdx !== -1);
		assert.equal(cutIdx, keptIdx - 1);
		assert.ok(momentIdx > keptIdx);
	});
});

// The chrome law (owner 2026-10-05): the leading SystemMessage (prompt + tools)
// is never persisted, so the cut must carry it ahead of the compaction head.
describe("toLlmMessages carries the leading system message (request chrome)", () => {
	const chrome = {
		id: "sys",
		role: "system",
		content: "SYSTEM PROMPT + tool declarations",
		toolsAdded: [{ name: "quiz" }, { name: "plan_init" }],
		timestamp: 0,
	};
	const record = (): LhMessage[] => [
		{ id: "old", role: "user", content: "dropped history", timestamp: 1 },
		{ id: "kept", role: "user", content: "kept tail", timestamp: 2 },
		newCompactionMarker("SUPERSEDED SUMMARY", {
			firstKeptMessageId: "kept",
			tokensBefore: 98,
			at: new Date(0).toISOString(),
		}),
		newCompactionMarker("SUMMARY", {
			firstKeptMessageId: "kept",
			tokensBefore: 99,
			at: new Date(0).toISOString(),
		}) as unknown as LhMessage,
	];

	it("chrome FIRST, then the compaction head, then the kept tail — never dropped by the cut", () => {
		const out = toLlmMessages([chrome, ...record()] as never);
		assert.equal(out[0]!.role, "system");
		const flat = JSON.stringify(out);
		assert.ok(flat.indexOf("SUMMARY") < flat.indexOf("kept tail"));
		assert.ok(!flat.includes("dropped history") && !flat.includes("SUPERSEDED SUMMARY"));
		assert.equal(flat.split(COMPACTED_HISTORY_HEADER).length - 1, 1);
	});

	it("without a cut the chrome renders EXACTLY ONCE", () => {
		const out = toLlmMessages([chrome, { id: "u1", role: "user", content: "hello", timestamp: 1 }] as never);
		assert.deepEqual(out.map((m) => m.role), ["system", "user"]);
	});
});
