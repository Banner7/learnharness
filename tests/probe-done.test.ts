/**
 * probe_done — the probe→planning seam tool (docs/probe-teach-split.md §2).
 * Refuses while a question is open or after the probe concluded; otherwise
 * ok + the handoff marker is queued (deliver injected here).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { probeDoneTool } from "../src/agent/tools/probe.ts";
import type { SteerMessage } from "../src/core/contracts.ts";
import { hasProbeDone, type LhMessage } from "../src/core/native-messages.ts";
import { phaseAt3Lh } from "../src/core/phases.ts";
import { HANDOFF_TEXT } from "../src/core/contracts.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

fs.mkdirSync(PATHS.data, { recursive: true });

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
});

function newChat(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	return chat.id;
}

const ASSESSMENT = {
	strands: [{ strand: "the derivative as a limit", assessment: "Floor: slope intuition. Ceiling: formal ε–δ." }],
	summary: "Enter at the formal definition.",
};

function assistantWithCall(id: string, toolName: string, args: unknown): LhMessage {
	return {
		id, role: "assistant", content: [{ type: "toolCall", id: `call_${id}`, name: toolName, arguments: args as never }],
		api: "openai-completions", provider: "openrouter", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 1,
	} as never;
}

/** A real record result, distinct from the calling assistant message. */
function probeResult(overrides: Partial<Extract<LhMessage, { role: "toolResult" }>> = {}): LhMessage {
	return {
		id: "probe-result", role: "toolResult", toolCallId: "call_probe", toolName: "probe_done",
		content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1,
		...overrides,
	};
}

const probeCall = () => assistantWithCall("probe", "probe_done", { assessment: ASSESSMENT });

async function conclude(chatId: string, deliver: (s: SteerMessage) => void) {
	const result = await probeDoneTool({ chatId, chatStore, deliver }).probe_done!.execute!("test", { assessment: ASSESSMENT });
	return result.details as { ok: boolean; error?: string };
}

describe("probe_done: the probe→planning seam", () => {
	it("ok path: queues the handoff marker once (deterministic id)", async () => {
		const chatId = newChat("Probe: ok");
		const delivered: SteerMessage[] = [];
		const res = await conclude(chatId, (s) => delivered.push(s));
		assert.equal(res.ok, true);
		assert.equal(res.error, undefined);
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0]!.id, `steer_probe_${chatId}`);
		assert.equal(delivered[0]!.customType, "probe-handoff");
		assert.equal(delivered[0]!.content, HANDOFF_TEXT);
		assert.equal((delivered[0]!.details as { chatId: string }).chatId, chatId);
	});

	for (const [name, messages, error] of [
		["a question is still open", [assistantWithCall("m1", "quiz", { question: "q?", options: [{ label: "a" }], correctAnswer: "a" })], /question is still open/i],
		["the probe already concluded", [probeCall(), probeResult()], /already concluded/i],
	] as const) {
		it(`REFUSES while ${name}, queueing nothing`, async () => {
			const chatId = newChat(`Probe: ${name}`);
			chatStore.saveMessages(chatId, [...messages]);
			const delivered: SteerMessage[] = [];
			const res = await conclude(chatId, (s) => delivered.push(s));
			assert.equal(res.ok, false);
			assert.match(res.error!, error);
			assert.equal(delivered.length, 0);
		});
	}

	it("REFUSES an unknown chat defensively", async () => {
		const res = await conclude("chat_nonexistent", () => {});
		assert.match(res.error!, /not found/i);
	});

	it("a deliver failure never fails the call — the wake is recoverable-by-design", async () => {
		const res = await conclude(newChat("Probe: deliver crash"), () => { throw new Error("queue exploded"); });
		assert.equal(res.ok, true);
	});
});

const failedProbeCall = (stopReason: "error" | "aborted"): LhMessage => ({ ...probeCall(), stopReason } as LhMessage);
const incompleteProbes: Array<[string, () => LhMessage[]]> = [
	["unmatched call", () => [probeCall()]],
	["errored result", () => [probeCall(), probeResult({ isError: true })]],
	["explicit refusal without isError", () => [probeCall(), probeResult({ details: { ok: false, error: "refused" } })]],
	["result without a call", () => [probeResult()]],
	["wrong call id", () => [probeCall(), probeResult({ toolCallId: "other" })]],
	["wrong result tool name", () => [probeCall(), probeResult({ toolName: "plan_init" })]],
	["wrong call tool name", () => [assistantWithCall("probe", "plan_init", {}), probeResult()]],
	["result before the call", () => [probeResult(), probeCall()]],
	["failed calling generation", () => [failedProbeCall("error"), probeResult({ details: { ok: true } })]],
	["aborted calling generation", () => [failedProbeCall("aborted"), probeResult({ details: { ok: true } })]],
];

describe("probe completion: matched successful results only (PR130 foundation)", () => {
	for (const [name, messages] of incompleteProbes) {
		it(`${name} keeps probing open and allows a fresh conclusion`, async () => {
			const chatId = newChat(`Probe recovery: ${name}`);
			const before = messages();
			const snapshot = structuredClone(before);
			chatStore.saveMessages(chatId, before);
			assert.equal(hasProbeDone(before), false);
			assert.equal(phaseAt3Lh(before), "probe");
			const delivered: SteerMessage[] = [];
			assert.equal((await conclude(chatId, (s) => delivered.push(s))).ok, true);
			assert.equal(delivered.length, 1, "only the fresh invocation queues a handoff");
			assert.deepEqual(before, snapshot, "the scans never mutate history");
			assert.deepEqual(chatStore.getChat(chatId)!.messages, snapshot, "the tool does not delete or replay saved attempts");
		});
	}

	for (const [name, result] of [
		["current acknowledgment", probeResult({ details: { ok: true } })],
		["older clean acknowledgment without details", probeResult()],
		["older clean acknowledgment without ok", probeResult({ details: { assessment: ASSESSMENT } })],
	] as const) {
		it(`${name} concludes exactly at the matching result`, () => {
			const messages = [probeCall(), result];
			assert.equal(hasProbeDone(messages), true);
			assert.equal(phaseAt3Lh(messages, 0), "probe", "a future result cannot conclude an earlier prefix");
			assert.equal(phaseAt3Lh(messages, 1), "plan");
		});
	}
});
