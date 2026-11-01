// Practice record mechanics (owner 2026-10-04): the active-problem fold, the
// thinking marker, the deferred dismissal conclude, and the model-facing seam.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	activeProblemOf,
	asAgentMessages,
	concludedByDismissalPair,
	newProblemDismissedMarker,
	newThinkingMessage,
	needsContinuation,
	pendingProblemDismissalOf,
	toLlmMessages,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { dismissAppends, inputAppends, parseChatInput, parseDismissInput } from "../src/core/input-events.ts";
import { modelSolutionForConclude } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/index.ts";

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
} as const;

function problemPose(callId = "call_p1", statement = "Show that…"): LhMessage[] {
	const assistant: LhMessage & AssistantMessage = {
		id: `msg_a_${callId}`,
		role: "assistant",
		content: [
			{ type: "toolCall", id: callId, name: PRACTICE_PROBLEM_TOOL, arguments: { statement, mode: "recall", modelSolution: statement } },
		],
		timestamp: 1,
		...STAMPS,
	};
	const ack: LhMessage & ToolResultMessage = {
		id: `msg_r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: PRACTICE_PROBLEM_TOOL,
		content: [{ type: "text", text: "Problem posed — the turn ends here." }],
		details: null,
		isError: false,
		timestamp: 2,
	};
	return [assistant, ack];
}

function concludeCall(outcome: string): LhMessage[] {
	return [
		{
			id: `msg_c_${outcome}`,
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: `call_conclude_${outcome}`,
					name: PRACTICE_CONCLUDE_TOOL,
					arguments: { outcome },
				},
			],
			timestamp: 3,
			...STAMPS,
		},
		{
			id: `msg_cr_${outcome}`,
			role: "toolResult",
			toolCallId: `call_conclude_${outcome}`,
			toolName: PRACTICE_CONCLUDE_TOOL,
			content: [{ type: "text", text: "Problem concluded — the composer is free; pose the next problem or wrap up." }],
			details: null,
			isError: false,
			timestamp: 4,
		},
	];
}

const errored = (pair: LhMessage[]): LhMessage[] => {
	(pair[1]! as unknown as { isError: boolean }).isError = true;
	return pair;
};

describe("activeProblemOf (the conclude-before-next-problem gate's fold)", () => {
	it("a posed problem (call + ack) is ACTIVE with its input", () => {
		assert.deepEqual(activeProblemOf(problemPose())?.input, { statement: "Show that…", mode: "recall", modelSolution: "Show that…" });
	});

	it("folds conclusions, refusals, dangling calls and dismissals honestly", () => {
		const cases: Array<[string, LhMessage[], string | null]> = [
			["thinking keeps it active", [...problemPose(), newThinkingMessage("call_p1", "stuck")], "call_p1"],
			["a clean conclude frees", [...problemPose(), ...concludeCall("solved")], null],
			["an ERRORED pose never activates (the BKT phantom)", errored(problemPose("call_bad")), null],
			["a refusal skips to the clean pose below", [...problemPose(), ...errored(problemPose("call_bad"))], "call_p1"],
			["an ERRORED conclude does not free", [...problemPose(), ...errored(concludeCall("solved"))], "call_p1"],
			["a DANGLING pose has not gone through", [problemPose("call_new")[0]!], null],
			["a dismissal frees immediately", [...problemPose(), newProblemDismissedMarker("call_p1")], null],
			["a newer problem after a conclude", [...problemPose(), ...concludeCall("solved"), ...problemPose("call_p2")], "call_p2"],
		];
		for (const [label, messages, active] of cases) assert.equal(activeProblemOf(messages)?.toolCallId ?? null, active, label);
	});
});

describe("pendingProblemDismissalOf (the marker waiting for its synthesis)", () => {
	it("a trailing dismissal marker pends", () => {
		const messages = [...problemPose(), newProblemDismissedMarker("call_p1")];
		assert.equal(pendingProblemDismissalOf(messages), "call_p1");
	});

	it("the synthesized pair clears it", () => {
		const messages = [...problemPose(), newProblemDismissedMarker("call_p1"), ...concludedByDismissalPair("call_p1")];
		assert.equal(pendingProblemDismissalOf(messages), null);
	});
});

describe("the thinking input", () => {
	it("parses and appends the marker against the active problem (ONE lane)", () => {
		const input = parseChatInput({ type: "thinking", problemCallId: "call_p1", text: "I think the inactivity constraint applies here" });
		const appends = inputAppends({ messages: problemPose() }, input);
		assert.equal(appends.length, 1);
	});

	it("400s against a stale or unknown problem call", () => {
		assert.throws(
			() => inputAppends({ messages: problemPose() }, { type: "thinking", problemCallId: "call_ghost", text: "x" }),
			/targets no active problem/,
		);
	});
});

describe("the next input", () => {
	it("parses bare and appends the practice-next marker in an idle practice session", () => {
		const input = parseChatInput({ type: "next" });
		const appends = inputAppends({ messages: [], kind: "practice" }, input);
		assert.equal(appends.length, 1);
	});

	it("400s outside practice sessions (the affordance is practice-only)", () => {
		assert.throws(() => inputAppends({ messages: [], kind: "teach" }, { type: "next" }), /practice-session/);
		assert.throws(() => inputAppends({ messages: [] }, { type: "next" }), /practice-session/);
	});

	it("400s while a problem is active (mid-problem input rides the dock)", () => {
		assert.throws(() => inputAppends({ messages: problemPose(), kind: "practice" }, { type: "next" }), /no active problem/);
	});

	it("rides AFTER a pending dismissal conclusion, exactly like text", () => {
		const dismissed = [...problemPose(), newProblemDismissedMarker("call_p1")];
		const appends = inputAppends({ messages: dismissed, kind: "practice" }, { type: "next" });
		assert.equal(appends.length, 3); // conclude pair + the next marker
	});
});

describe("the dismissal's conclude synthesis rides the next input", () => {
	it("text after a dismissal prepends the conclude pair before the user message", () => {
		const record = { messages: [...problemPose(), newProblemDismissedMarker("call_p1")] };
		const appends = inputAppends(record, { type: "text", text: "that one was over my head" });
		assert.equal(appends.length, 3);
		assert.deepEqual(appends.map((m) => m.role), ["assistant", "toolResult", "user"]);
		assert.deepEqual(appends[0]!.content, [{ type: "toolCall", id: (appends[1] as ToolResultMessage).toolCallId, name: PRACTICE_CONCLUDE_TOOL, arguments: { outcome: "dismissed" } }]);
	});
});

describe("the dismiss-problem input (ask-style discard)", () => {
	it("parses and appends the UI-only marker against the active problem", () => {
		const input = parseDismissInput({ type: "dismiss-problem", problemCallId: "call_p1" });
		const appends = dismissAppends({ messages: problemPose() }, input);
		assert.equal(appends.length, 1);
		assert.equal((appends[0] as { customType: string }).customType, "problem-dismissed");
	});

	it("400s when nothing active or a stale id", () => {
		assert.throws(() => dismissAppends({ messages: [] }, { type: "dismiss-problem", problemCallId: "x" }), /no active problem/);
		const concluded = [...problemPose(), ...concludeCall("solved")];
		assert.throws(() => dismissAppends({ messages: concluded }, { type: "dismiss-problem", problemCallId: "call_p1" }), /no active problem/);
	});
});

describe("toLlmMessages (practice shapes)", () => {
	it("the thinking marker flattens to a labeled user message; the dismissal marker is UI-only", () => {
		const out = toLlmMessages(asAgentMessages([newThinkingMessage("call_p1", "It is 42"), newProblemDismissedMarker("call_p1")]));
		assert.equal(out.length, 1);
		assert.equal(out[0]!.role, "user");
	});
});

describe("needsContinuation (a persisted pose ack owes nothing)", () => {
	it("a record ending on a problem-pose ack does NOT wake a continuation (the pose ended the turn)", () => {
		assert.equal(needsContinuation(problemPose()), false);
	});

	it("an ERROR result is not a pose — the agent loop continues past it, so a record ending there (an abort) is owed the wake like any interrupted tool", () => {
		const messages = [...problemPose("call_pe")];
		const err = messages[1] as LhMessage & ToolResultMessage;
		err.isError = true;
		err.content = [{ type: "text", text: "A problem is already active." }];
		assert.equal(needsContinuation(messages), true);
	});
});

describe("modelSolutionForConclude (the conclusion's hero is the pose's commitment)", () => {
	it("skips refused poses — a rejected pose revealed nothing", () => {
		const messages = [...errored(problemPose("call_bad", "A different student…")), ...concludeCall("solved")];
		assert.equal(modelSolutionForConclude(messages, "call_conclude_solved"), undefined);
	});

	it("the newest pose before ITS conclude wins (multi-problem records)", () => {
		const messages = [
			...problemPose("call_p1", "first"),
			...concludeCall("solved"),
			...problemPose("call_p2", "second"),
			...concludeCall("movedOn"),
		];
		assert.equal(modelSolutionForConclude(messages, "call_conclude_movedOn"), "second");
		assert.equal(modelSolutionForConclude(messages, "call_conclude_solved"), "first");
	});

	it("projectView enriches the conclude part with the reveal and the full pose input", () => {
		const conclude = projectView([...problemPose(), ...concludeCall("solved")]).flatMap((m) => m.parts).find((p) => p.type === "tool-conclude");
		assert.equal(conclude!.reveal, "Show that…");
		assert.deepEqual(conclude!.problemInput, { statement: "Show that…", mode: "recall", modelSolution: "Show that…" });
	});
});
