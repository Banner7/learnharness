/**
 * THE PRACTICE SURFACE — SSR render pins: the problem card (the
 * commitment NEVER renders), the conclusion's reveal, the graph-context
 * card's collapsed default, and the view projection (the thinking
 * marker's data part; the problem pose's mount state).
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";

import { ConcludeCard, ProblemCard } from "../components/practice-cards.tsx";
import { GraphContextCard } from "../components/graph-context-card.tsx";
import { projectView } from "../src/core/view.ts";
import type { ArtifactPartProps } from "../src/core";
import {
	newThinkingMessage,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";

const part = (over: Partial<ArtifactPartProps["part"]>): ArtifactPartProps["part"] => ({
	type: "tool-problem",
	state: "input-available",
	toolCallId: "call_p1",
	...over,
});

describe("the practice transcript cards", () => {
	it("ProblemCard: the statement renders — the commitment NEVER does", () => {
		const html = renderToStaticMarkup(
			<ProblemCard part={part({ input: { statement: "Prove the parity claim.", mode: "recall", modelSolution: "Pair them." } })} />,
		);
		assert.match(html, /Prove the parity claim\./);
		assert.doesNotMatch(html, /Pair them\./, "the commitment stays hidden");
	});

	it("ConcludeCard: reveals the pose's solution (or a legacy record's own solutionReveal); a dismissal reveals nothing", () => {
		const reveal = renderToStaticMarkup(
			<ConcludeCard part={part({ type: "tool-conclude", input: { outcome: "solvedWithHints", verdict: "The pairing came after R2." }, reveal: "Pair them; each pair is even." })} />,
		);
		assert.match(reveal, /Pair them; each pair is even\./);
		assert.match(reveal, /The pairing came after R2\./);
		const legacy = renderToStaticMarkup(
			<ConcludeCard part={part({ type: "tool-conclude", input: { outcome: "solved", verdict: "Clean.", solutionReveal: "Pair them; each pair is even." } })} />,
		);
		assert.match(legacy, /Pair them; each pair is even\./);
		const dismissed = renderToStaticMarkup(
			<ConcludeCard part={part({ type: "tool-conclude", input: { outcome: "dismissed" }, reveal: "The solution." })} />,
		);
		assert.doesNotMatch(dismissed, /The solution/);
	});
});

describe("the practice view projection", () => {
	it("the thinking marker projects as a user-side data part", () => {
		const view = projectView([newThinkingMessage("call_p1", "It is 42.") as LhMessage]);
		assert.equal(view.length, 1);
		assert.equal(view[0]!.role, "user");
		const dataPart = view[0]!.parts[0]!;
		assert.equal(dataPart.type, "data-practice-thinking");
		assert.deepEqual(dataPart.data, { problemCallId: "call_p1", text: "It is 42." });
	});

	it("the problem pose's ack keeps the part input-available (the dock's mount)", () => {
		const messages = [
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call_p1", name: PRACTICE_PROBLEM_TOOL, arguments: { statement: "S." } }],
			},
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "call_p1",
				toolName: PRACTICE_PROBLEM_TOOL,
				content: [{ type: "text", text: "Problem posed" }],
				details: null,
				isError: false,
			},
		] as unknown as LhMessage[];
		const toolPart = projectView(messages)[0]!.parts.find((p) => p.type === `tool-${PRACTICE_PROBLEM_TOOL}`)!;
		assert.equal(toolPart.state, "input-available");
	});
});

describe("GraphContextCard", () => {
	it("collapsed by default: counts only — the statements stay hidden", () => {
		const html = renderToStaticMarkup(
			<GraphContextCard data={{ propositions: [
				{ id: "n1", name: "Modus ponens", statement: "If P implies Q and P holds, Q holds." },
				{ id: "n2", name: "Soundness", statement: "A valid argument from true premises has a true conclusion." },
			], chains: ["Modus ponens → Soundness"] }} />,
		);
		assert.ok(html.includes("2 propositions"));
		assert.ok(html.includes("1 chain"));
		assert.ok(!html.includes("If P implies Q"));
	});
});
