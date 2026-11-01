/**
 * The shared session-markdown engine (core/session-markdown.ts, owner ruling
 * 2026-09-27): ONE renderer for the extractor's source view and the
 * user-facing session export — id-anchored speaker blocks, readable
 * question blocks, one-line notes for other tools, the practice join.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import { messageMarkdown, sessionMarkdown } from "../src/core/session-markdown.ts";
import { messageViewLines } from "../src/core/coverage.ts";

function user(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: 1 } as never;
}

function assistant(id: string, content: unknown[]): LhMessage {
	return {
		id, role: "assistant", content, api: "openai-completions", provider: "openrouter", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 1,
	} as never;
}

const teacher = (id: string, text: string) => assistant(id, [{ type: "text", text }]);
/** The practice join's call side — args live HERE, the results are bare acks. */
const callMsg = (id: string, callId: string, name: string, args: unknown) =>
	assistant(id, [{ type: "toolCall", id: callId, name, arguments: args }]);

function result(id: string, toolCallId: string, toolName: string, details: unknown, isError = false): LhMessage {
	return { id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: 1 } as never;
}

describe("messageMarkdown", () => {
	it("renders speaker blocks with the id anchor, or without it for the user export", () => {
		assert.equal(messageMarkdown(user("u1", "teach me the chain rule"), "u1"), "### Learner · u1\n\nteach me the chain rule");
		assert.equal(messageMarkdown(teacher("a1", "The derivative measures change."), "a1"), "### Teacher · a1\n\nThe derivative measures change.");
		assert.equal(messageMarkdown(user("u1", "hello"), "u1", false), "### Learner\n\nhello");
	});

	it("question results render the question and the learner's answer under their own heading", () => {
		const cases: Array<[string, unknown, RegExp[]]> = [
			["quiz", { questionText: "What is a derivative?", correct: false, dontKnow: false, note: "mixed up signs" },
				[/^### Quiz · r1$/m, /\*\*Q:\*\* What is a derivative\?/, /answered incorrectly/, /mixed up signs/]],
			["explain", { questionText: "Why?", text: "it never strays far" }, [/^### Recall check · r1$/m, /it never strays far/]],
			["probe", { questionText: "What is a derivative?", correct: true, dontKnow: false }, [/^### Probe · r1$/m]],
			["recall", { questionText: "Why?", text: "it never strays far" }, [/^### Recall · r1$/m]],
			["ask_user_question", { questionText: "Which way?", answers: ["second"], other: "also the third" },
				[/^### Question · r1$/m, /second, also the third/]],
			["ask_user_question", { questionText: "Why?", text: "because" }, [/because/]],
		];
		for (const [name, details, patterns] of cases) {
			const md = messageMarkdown(result("r1", "c1", name, details), "r1")!;
			for (const pattern of patterns) assert.match(md, pattern, name);
		}
	});

	it("other clean tool results: one line; failed calls and empty text: nothing", () => {
		assert.equal(messageMarkdown(result("r1", "j1", "research", { brief: "long" }), "r1"), "### Tool · r1\n\n*research result delivered*");
		assert.equal(messageMarkdown(result("r2", "j2", "research", {}, true), "r2"), null, "a failed call is retry context");
		assert.equal(messageMarkdown(user("u3", "   "), "u3"), null);
	});
});

describe("sessionMarkdown — the practice join (owner-approved, 2026-10-06)", () => {
	const pose = (args: Record<string, unknown>, isError = false) => [
		callMsg("a1", "call-p1", "problem", args),
		result("r1", "call-p1", "problem", null, isError),
	];
	const conclude = (args: Record<string, unknown>) => [
		callMsg("a2", "call-c1", "conclude", args),
		result("r2", "call-c1", "conclude", null),
	];

	it("a problem result renders the POSE's statement without leaking the solution", () => {
		const md = sessionMarkdown(pose({ statement: "Push the prior through.", mode: "recall", target: [], modelSolution: "Two phases." }));
		assert.ok(md.includes("### Problem") && md.includes("Push the prior through."));
		assert.ok(!md.includes("Two phases"), "the solution does NOT leak at pose time");
	});

	it("a conclude result renders outcome + verdict + the pose's model solution as the reveal", () => {
		const md = sessionMarkdown([
			...pose({ statement: "Compute P(knows | correct).", modelSolution: "Bayes, twice over." }),
			...conclude({ outcome: "solvedWithHints", verdict: "Right answer, one nudge." }),
		]);
		assert.ok(md.includes("### Concluded"));
		assert.ok(md.includes("**Solved with hints.** Right answer, one nudge."));
		assert.ok(md.includes("> Bayes, twice over."), "the reveal quotes the committed solution");
	});

	it("a dismissed problem concludes without leaking the model solution", () => {
		const md = sessionMarkdown([
			...pose({ statement: "Derive the posterior.", modelSolution: "The answer." }),
			...conclude({ outcome: "dismissed" }),
		]);
		assert.ok(md.includes("### Problem"), "the statement still renders (it was on screen)");
		assert.ok(!md.includes("The answer."), "no reveal on a skipped problem");
	});

	it("an errored pose renders nothing", () => {
		assert.ok(!sessionMarkdown(pose({ statement: "Never acked." }, true)).includes("Never acked."));
	});
});

describe("sessionMarkdown", () => {
	it("assembles blocks in order under the optional title header, skipping nothings", () => {
		const md = sessionMarkdown([user("u1", "go"), teacher("a1", "First."), user("u2", "  ")], { title: "My session" });
		assert.equal(md, "# My session\n\n### Learner · u1\n\ngo\n\n### Teacher · a1\n\nFirst.");
		assert.equal(sessionMarkdown([user("u1", "go")]), "### Learner · u1\n\ngo");
	});

	it("the seam split (owner, 2026-09-28): teacher prose renders in BOTH; the rest renders ONLY here", () => {
		const messages: LhMessage[] = [
			user("u1", "teach me"),
			teacher("a1", "The chain rule multiplies local rates."),
			result("r1", "q1", "quiz", { questionText: "Q?", correct: true, dontKnow: false }),
			result("r2", "j1", "research", { brief: "b" }),
			result("r3", "j2", "research", {}, true),
		];
		for (const message of messages) {
			const isTeacher = message.role === "assistant";
			const hasLines = messageViewLines(message, message.id).length > 0;
			const hasMarkdown = messageMarkdown(message, message.id) !== null;
			assert.equal(hasLines, isTeacher && hasMarkdown, `view lines follow teacher prose for ${message.id}`);
		}
	});
});
