import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

import { PRACTICE_PROBLEM_TOOL, type LhMessage } from "../src/core/native-messages.ts";
import { concludeTool, createPracticeGate, problemTool, practiceTools } from "../src/agent/tools/practice.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const STAMPS = {
	api: "faux", provider: "test", model: "test-model", stopReason: "toolUse",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} as const;

/** A record whose latest problem call is ACTIVE (pose + ack, nothing after). */
function activeProblemRecord(): LhMessage[] {
	const pose: LhMessage & AssistantMessage = {
		id: "msg_a1",
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_p1", name: PRACTICE_PROBLEM_TOOL, arguments: { statement: "Show…" } },
		],
		timestamp: 1,
		...STAMPS,
	};
	const ack: LhMessage & ToolResultMessage = {
		id: "msg_r1",
		role: "toolResult",
		toolCallId: "call_p1",
		toolName: PRACTICE_PROBLEM_TOOL,
		content: [{ type: "text", text: "Problem posed — the turn ends here…" }],
		details: null,
		isError: false,
		timestamp: 2,
	};
	return [pose, ack];
}

const ctxOf = (messages: LhMessage[]) => ({ chatId: "c1", chatStore: { getChat: (_id: string) => ({ messages, kind: "practice" }) } });
const PROBLEM_INPUT = {
	statement: "Prove the sum is even.",
	mode: "recall",
	target: ["parity-sum"],
	modelSolution: "Pair them; each pair is even.",
} as const;

const CONCLUDE_INPUT = {
	outcome: "solved",
	verdict: "Clean — the pairing came unaided.",
	rung: null,
	missClass: null,
	retest: false,
} as const;

// ── the gating law ───────────────────────────────────────────────────────────

describe("the practice tool gating law", () => {
	it("problem acks on a quiet record and ends the turn (terminate)", async () => {
		const result = await problemTool(createPracticeGate(ctxOf([]))).execute("call_x", PROBLEM_INPUT as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, true);
		assert.match((result.content[0] as { text: string }).text, /Problem posed/);
	});

	it("problem is REJECTED while a problem is active (conclude first)", async () => {
		const result = await problemTool(createPracticeGate(ctxOf(activeProblemRecord()))).execute("call_x", PROBLEM_INPUT as never);
		assert.equal(result.isError, true);
		assert.deepEqual((result.details as { problems: string[] }).problems, [
			"a problem is already active — call conclude on it before posing the next one",
		]);
	});

	it("conclude is REJECTED with nothing active", async () => {
		const result = await concludeTool(createPracticeGate(ctxOf([]))).execute("call_x", CONCLUDE_INPUT as never);
		assert.equal(result.isError, true);
		assert.deepEqual((result.details as { problems: string[] }).problems, [
			"no active problem to conclude — pose one first",
		]);
	});

	it("conclude acks on the active problem and the turn CONTINUES (no terminate)", async () => {
		const result = await concludeTool(createPracticeGate(ctxOf(activeProblemRecord()))).execute("call_x", CONCLUDE_INPUT as never);
		assert.equal(result.isError, undefined);
		assert.equal(result.terminate, undefined);
	});

	it("THE BKT INCIDENT — a mid-turn conclude → pose pair works (the gate is turn-scoped, not record-frozen)", async () => {
		// One turn, one toolset: the record froze at the write-ahead with
		// the old problem active. The gates used to re-read that frozen
		// record per execute, so the pose after a successful conclude
		// always died on "a problem is already active" until the model
		// gave up ("the problem slot is stuck").
		const gate = createPracticeGate(ctxOf(activeProblemRecord()));
		const tools = { problem: problemTool(gate), conclude: concludeTool(gate) };
		const conclude = await tools.conclude.execute("call_c1", CONCLUDE_INPUT as never);
		assert.equal(conclude.isError, undefined, "the conclude acks against the seeded record");
		const pose = await tools.problem.execute("call_p2", PROBLEM_INPUT as never);
		assert.equal(pose.isError, undefined, "the freed gate lets the next problem through — SAME turn");
		const greedy = await tools.problem.execute("call_p3", PROBLEM_INPUT as never);
		assert.equal(greedy.isError, true, "the gate re-arms on the successful pose");
	});
});

describe("target validation — names normalize to ids, unknowns reject", () => {
	const NODES = [
		{ id: "n_parity", name: "Parity of a sum", statement: "The sum of two odds is even." },
		{ id: "n_pairing", name: "Pairing", statement: "Pair elements to count parity." },
	] as const;
	const graphNodes = () => NODES;

	it("name targets normalize case-insensitively to ids; ids pass through", () => {
		const tool = problemTool(createPracticeGate(ctxOf([])), graphNodes);
		const healed = tool.prepareArguments!({ ...PROBLEM_INPUT, target: ["Parity of a sum", "pairing", "n_parity"] }) as { target: string[] };
		assert.deepEqual(healed.target, ["n_parity", "n_pairing", "n_parity"]);
	});

	it("an UNKNOWN target rejects and does NOT arm the gate", async () => {
		const tool = problemTool(createPracticeGate(ctxOf([])), graphNodes);
		const rejected = await tool.execute("call_x", { ...PROBLEM_INPUT, target: ["ghost-prop"] } as never);
		assert.equal(rejected.isError, true);
		assert.match((rejected.details as { problems: string[] }).problems[0]!, /ghost-prop/);
		const valid = await tool.execute("call_y", { ...PROBLEM_INPUT, target: ["n_parity"] } as never);
		assert.equal(valid.isError, undefined);
	});

	it("absent target poses freely; [] heals away to absent", async () => {
		const tool = problemTool(createPracticeGate(ctxOf([])), graphNodes);
		const absent = await tool.execute("call_a", { statement: "S", mode: "recall", modelSolution: "M" } as never);
		assert.equal(absent.isError, undefined);
		const healed = tool.prepareArguments!({ statement: "S", mode: "recall", target: [], modelSolution: "M" }) as { target?: string[] };
		assert.ok(!healed.target || healed.target.length === 0);
	});
});

describe("the practice agent", () => {
	it("registry: the session pair + learner-filesystem set; jobs + map readers only when their roots are passed", () => {
		assert.deepEqual(Object.keys(practiceTools(ctxOf([]))).sort(), ["conclude", "find", "grep", "ls", "problem", "read"]);
		const jobs = { chatId: "c1", jobStore: null as never, spawn: (() => {}) as never, searchAvailable: () => false };
		const graph = { chatStore: null as never, graphStore: null as never };
		assert.deepEqual(
			Object.keys(practiceTools({ ...ctxOf([]), jobs, graph })).sort(),
			["conclude", "find", "grep", "list_propositions", "list_sessions", "ls", "pdf", "problem", "read", "research"],
		);
	});

	it("practice composes its own base + doctrine, not the teaching prompt, with formatting as the appendix", () => {
		const prompt = composeInstructions("practice");
		assert.match(prompt, /You run practice sessions\./);
		assert.doesNotMatch(prompt, /install understanding/);
		assert.ok(prompt.indexOf("# The practice session") < prompt.indexOf("## Formatting"));
	});
});
