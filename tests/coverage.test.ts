import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newAnswerResult, newPlanBlockMessage, newUserMessage } from "../src/core/native-messages.ts";

import {
	batchRuns,
	batchTag,
	coverageOf,
	coverageSlots,
	messageFingerprint,
	messageViewLines,
} from "../src/core/coverage.ts";
import type { CoverageEntry } from "../src/core/contracts/graph.ts";

/**
 * Extraction coverage — the pure core under the TEACHER-PROSE ruling
 * (owner, 2026-09-28): the extractor sees only the teacher's text
 * blocks; fingerprints, slots, tokens, and batching all derive from that
 * one selection. Everything else is invisible.
 */

function user(id: string, text: string): LhMessage {
	return { ...newUserMessage(text), id };
}

function teacher(id: string, text: string): LhMessage {
	return { id, role: "assistant", content: [{ type: "text", text }] } as unknown as LhMessage;
}

function result(id: string, callId: string, name: string, details: unknown): LhMessage {
	return { ...newAnswerResult(callId, name, details), id } as LhMessage;
}

function slot(messages: ReadonlyArray<LhMessage>, id: string) {
	const found = coverageSlots(messages).find((s) => s.message.id === id);
	assert.ok(found, `slot ${id}`);
	return found;
}

const runIds = (runs: ReadonlyArray<ReadonlyArray<{ message: LhMessage }>>) => runs.map((r) => r.map((s) => s.message.id));

describe("messageFingerprint — what changes it, what never does", () => {
	it("text, id (the provenance tag) and role participate; identical input re-fingerprints equal", () => {
		const a = messageFingerprint(teacher("m1", "hello world"));
		assert.equal(a, messageFingerprint(teacher("m1", "hello world")));
		assert.notEqual(a, messageFingerprint(teacher("m1", "hello worlds")));
		assert.notEqual(a, messageFingerprint(teacher("m2", "hello world")));
		assert.notEqual(a, messageFingerprint(user("m1", "hello world")));
	});

	it("markers, learner messages, quiz Q&A and ALL tool results are invisible", () => {
		const marker = newPlanBlockMessage("call_p1", {
			kind: "full", at: "2026-09-26T00:00:00.000Z", current: null, nodes: [], edges: [],
		}) as LhMessage;
		const asking = { id: "a1", role: "assistant", content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { question: "Q?" } }] } as unknown as LhMessage;
		const answer = result("r1", "q1", "quiz", { questionText: "Q?", correct: true });
		const failed = { ...newAnswerResult("j2", "visual", { oops: true }), isError: true, id: "r9" } as LhMessage;
		for (const message of [marker, asking, answer, failed, user("u1", "teach me"), result("r2", "j1", "demo", { title: "T" })]) {
			assert.deepEqual(messageViewLines(message, message.id), [], message.id);
		}
		assert.equal(slot([asking, answer], "a1").tokens, 0);
	});
});

describe("coverageOf — uncovered is DERIVED, never dual-tracked", () => {
	it("diffs fingerprints per chat: covered stays, uncovered counts, tokens split", () => {
		const messages = [teacher("m1", "aaaa"), teacher("m2", "bbbb"), teacher("m3", "cccc")];
		const entry = (chatId: string, id: string): CoverageEntry => ({ chatId, fp: slot(messages, id).fp, tokens: 1, foldedAt: "2026-09-15T00:00:00.000Z" });
		// Another chat's entries are irrelevant to c1's coverage.
		const cov = coverageOf(messages, [entry("c1", "m1"), entry("c1", "m2"), entry("c2", "m3")], "c1");
		assert.deepEqual(cov.uncovered, [2], "uncovered is INDEXES (the batcher needs positions)");
		assert.equal(cov.coveredCount, 2);
		assert.equal(cov.uncoveredCount, 1);
		assert.equal(cov.uncoveredTokens, slot(messages, "m3").tokens);
		assert.equal(cov.coveredTokens, slot(messages, "m1").tokens + slot(messages, "m2").tokens);
	});

	it("a mutated covered message re-opens itself, and only itself", () => {
		const messages = [teacher("m1", "aaaa"), teacher("m2", "bbbb")];
		const entries: CoverageEntry[] = coverageSlots(messages).map((s) => ({ chatId: "c1", fp: s.fp, tokens: s.tokens, foldedAt: "2026-09-15T00:00:00.000Z" }));
		assert.equal(coverageOf(messages, entries, "c1").uncoveredCount, 0);
		assert.deepEqual(coverageOf([teacher("m1", "aaaa!"), messages[1]!], entries, "c1").uncovered, [0]);
	});
});

describe("batchRuns — token-budgeted, consecutive, never splits a message", () => {
	it("greedy oldest-first fill; the overflowing message starts the next run", () => {
		// Each view line is ~14 tok (chars/4) → budget 45 fits three.
		const slots = coverageSlots(["a", "b", "c", "d"].map((c, i) => teacher(`m${i + 1}`, c.repeat(40))));
		assert.deepEqual(runIds(batchRuns(slots, [0, 1, 2, 3], 45)), [["m1", "m2", "m3"], ["m4"]]);
	});

	it("an over-budget message is its own run; a non-positive budget or empty input yields no runs", () => {
		const slots = coverageSlots([teacher("m1", "x".repeat(400)), teacher("m2", "y".repeat(20))]);
		assert.deepEqual(runIds(batchRuns(slots, [0, 1], 10)), [["m1"], ["m2"]]);
		assert.deepEqual(batchRuns(coverageSlots([teacher("m1", "hi")]), [0], 0), []);
		assert.deepEqual(batchRuns([], [], 4096), []);
	});

	it("learner messages and tool results never join a batch — teacher prose only", () => {
		const messages = [
			user("u1", "learner asks"),
			teacher("t1", "x".repeat(40)),
			result("r1", "q1", "quiz", { questionText: "Q?", correct: true }),
			teacher("t2", "y".repeat(40)),
		];
		const cov = coverageOf(messages, [], "c1");
		assert.deepEqual(cov.uncovered, [1, 3]);
		assert.deepEqual(runIds(batchRuns(cov.slots, cov.uncovered, 15)), [["t1"], ["t2"]]);
	});
});

describe("batchTag — deterministic, ordered, mutation-sensitive", () => {
	it("same members in the same order → the same 12-hex tag; order or a mutated member changes it", () => {
		const slots = coverageSlots([teacher("m1", "aaaa"), teacher("m2", "bbbb")]);
		assert.equal(batchTag(slots), batchTag(coverageSlots([teacher("m1", "aaaa"), teacher("m2", "bbbb")])));
		assert.match(batchTag(slots), /^[0-9a-f]{12}$/);
		assert.notEqual(batchTag(slots), batchTag([...slots].reverse()));
		assert.notEqual(batchTag(slots), batchTag(coverageSlots([teacher("m1", "aaaa!"), teacher("m2", "bbbb")])));
	});
});
