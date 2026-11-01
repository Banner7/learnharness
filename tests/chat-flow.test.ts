/**
 * Scripted integration test — the full teacher loop with zero tokens, driving
 * handleChatRequest directly with pi-ai's faux provider. POSTs carry ONE input
 * event; the record is pi-native history; answers land as real tool results.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { handleChatInput, handleChatRequest } from "../src/server/chat-handler.ts";
import { effectiveSettings } from "../src/server/stores.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { deliverJobResult, registerLiveAgent, setTurnRunner, steerLiveChat, unregisterLiveAgent } from "../src/server/jobs.ts";
import { SessionModel } from "../components/session-core.ts";
import { buildSubagentSteer } from "../src/core/contracts.ts";
import { abortTurn, runningTurn, settledTurnResponse } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { buildAnswer, dismissedAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { danglingQuestionOf, endsInDismissal, needsContinuation, newAnswerResult, newUserMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

// Route handlers, driven directly.
const dismissRoute = await import("../server/routes/chats/[id]/dismiss/route.ts");
const steerRoute = await import("../server/routes/chats/[id]/steer/route.ts");
const streamRoute = await import("../server/routes/chats/[id]/stream/route.ts");
const recordRoute = await import("../server/routes/chats/[id]/route.ts");
import { PATHS } from "../config.ts";

// The key-presence turn gate reads env-first truth.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [
		{ label: "Venus" },
		{ label: "Mercury" },
		{ label: "Mars" },
	],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

/** A scripted engine; each response factory records the prompt it saw. */
function scriptedTeacher(steps: (calls: string[][]) => FauxResponseStep[]): {
	engine: PiEngine;
	calls: string[][];
} {
	const calls: string[][] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps(calls));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

/** The default two-turn lesson: probe quiz, then react to the answer. */
function defaultLesson(calls: string[][]): FauxResponseStep[] {
	return [
		(context) => {
			calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage(
				[fauxThinking("Probe the basics first."), fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" })],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage([fauxText("Right — Mercury it is.")]);
		},
	];
}

/** Each request builds a fresh agent off the native record. */
function agentFactory(engine: PiEngine): Parameters<typeof handleChatRequest>[1] {
	return (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages });
}

/** The graded answer a client sends for a quiz (the shared grading seam). */
function gradedAnswer(input: typeof QUIZ_INPUT, values: string[]) {
	const options = normalizeOptions(input.options);
	const qd: QuestionData = {
		id: "call-1",
		kind: "quiz",
		question: input.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(input.correctAnswer, options).indices,
		explanation: input.explanation,
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values });
}

/** Parse an SSE body into its wire events. */
function eventsOf(body: string): Array<Record<string, any>> {
	const out: Array<Record<string, any>> = [];
	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
		out.push(JSON.parse(line.slice(6)));
	}
	return out;
}

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) {
		assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	}
	return res.text(); // consumes the SSE stream to completion (fires onFinish)
}

/** POST /api/chat acks and closes; drain the turn through the reattach
 *  stream immediately (faux turns settle in microtask rounds). */
async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<string> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) {
		assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	}
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (!handle) return ""; // a short turn may settle inside the handler's awaits
	return new Response(handle.subscribe()).text();
}

/** Drain a RUNNING turn's wire when the POST already happened. */
async function drainRunning(chatId: string): Promise<string> {
	const handle = runningTurn(chatId);
	if (!handle) assert.fail(`no running turn to drain: ${chatId}`);
	return new Response(handle.subscribe()).text();
}

function waitFor(cond: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

/** A teacher whose step 1 blocks on an external gate — a turn held mid-run
 *  so view-cancel / reattach / abort timing is deterministic. */
function gatedTeacher(gate: Promise<void>): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxText("Gated reply.")]);
		},
	]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A teacher that NEVER resolves except on abort (the jobs abortableFactory
 *  pattern): the only way this turn can end is the remote kill. */
function abortableTeacher(): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses([
		((_ctx: unknown, opts: { signal?: AbortSignal } | undefined) =>
			new Promise((resolve) => {
				const sig = opts?.signal;
				if (sig?.aborted) return resolve(fauxAssistantMessage("late"));
				sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
			})) as unknown as FauxResponseStep,
	]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

/** The silent-dismissal route POST. */
function dismissPost(chatId: string, toolCallId: string, kind: "quiz" | "ask" | "explain" = "quiz"): Promise<Response> {
	return dismissRoute.POST(
		new Request(`http://test/api/chats/${chatId}/dismiss`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				input: { type: "dismiss", toolCallId, answer: dismissedAnswer(kind, kind === "ask" ? "Next topic?" : QUIZ_INPUT.question) },
			}),
		}),
		{ params: Promise.resolve({ id: chatId }) },
	);
}

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

/** BYOK turn gate: every scripted chat needs a per-chat model pin. */
function createConfiguredChat(title: string) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(chat.id, {
		nodes: [{ id: "planet-order", title: "Planet order" }, { id: "genealogy", title: "Genealogy of religion" }],
		edges: [],
		version: 1,
	});
	return chat;
}

describe("teacher chat flow (scripted model)", () => {
	it("quiz tool call persists as a pending part; the answer continues the lesson", async () => {
		const { engine, calls } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: solar system");

		await drainTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));

		const saved1 = chatStore.getChat(chat.id)!;
		// The clean question's placeholder result never persists: the record ends at the call.
		assert.equal(saved1.messages.length, 2, "user message + assistant response persisted");
		const pending = danglingQuestionOf(saved1.messages);
		assert.equal(pending?.toolCallId, "call-1");
		assert.deepEqual(pending?.input, QUIZ_INPUT);

		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer: gradedAnswer(QUIZ_INPUT, ["Mercury"]) }), agentFactory(engine));

		const saved2 = chatStore.getChat(chat.id)!;
		assert.equal(saved2.messages.length, 4, "the answer + reaction append natively");
		assert.equal((saved2.messages[2] as { role?: string }).role, "toolResult", "the graded answer is the call's tool result");
		const answeredQuiz = projectView(saved2.messages)[1]!.parts.find((p) => p.type === "tool-quiz") as { state?: string; output?: { correct?: boolean } };
		assert.equal(answeredQuiz.state, "output-available");
		assert.equal(answeredQuiz.output?.correct, true);
		assert.equal(calls.length, 2, "model saw exactly two prompts");
		assert.match(calls[1]!.join(" "), /Mercury/, "continuation prompt carries the tool result");
		assert.equal(danglingQuestionOf(saved2.messages), null);
	});

	it("rejects unknown chats", async () => {
		const res = await handleChatRequest(post("chat_nonexistent", { type: "text", text: "hi" }));
		assert.equal(res.status, 404);
	});

	it("refuses malformed inputs with a clean 400 — no liveness effects, no lockout", async () => {
		const chat = createConfiguredChat("Test: malformed input");

		const res = await handleChatRequest(post(chat.id, { type: "text" }), agentFactory(scriptedTeacher(defaultLesson).engine));
		assert.equal(res.status, 400, "malformed input is a clean 400");
		assert.equal(isTurnRunning(chat.id), false, "the refusal never registered a turn");

		// An answer with no dangling question call is refused.
		const res2 = await handleChatRequest(
			post(chat.id, { type: "answer", toolCallId: "call-none", answer: { correct: true } }),
			agentFactory(scriptedTeacher(defaultLesson).engine),
		);
		assert.equal(res2.status, 400, "an answer with no pending question call is refused");
		assert.equal(isTurnRunning(chat.id), false);

		// The chat is not locked: the next valid turn is accepted.
		const ok = await handleChatRequest(
			post(chat.id, { type: "text", text: "teach me" }),
			agentFactory(scriptedTeacher(defaultLesson).engine),
		);
		assert.equal(ok.status, 200);
		await drain(ok);
	});

	it("streams the toolCall partial before tool_execution_start/end (protocol pin for the 'Writing a question…' shimmer)", async () => {
		// The writing indicator derives from a toolCall in message_update; the dock mounts on a clean end.
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: protocol pin");
		const body = await drainTurn(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine));
		const events = eventsOf(body);
		const callSeen = events.findIndex(
			(e) => e.type === "message_update" && JSON.stringify(e.message?.content ?? []).includes('"type":"toolCall"'),
		);
		const execStart = events.findIndex((e) => e.type === "tool_execution_start" && e.toolCallId === "call-1");
		const execEnd = events.findIndex((e) => e.type === "tool_execution_end" && e.toolCallId === "call-1");
		assert.ok(callSeen !== -1 && callSeen < execStart && execStart < execEnd, "partial → execution start → execution end");
		assert.equal(events[execEnd]!.isError, false, "the clean end is what mounts the dock");
	});

	it("a pump-fired wake turn never double-appends its steer (Wave B regression of the 2026-09-18 bug)", { timeout: 15000 }, async () => {
		// The pump fires {type:'steer'} while the same steer still heads the
		// delivery queue; the marker once persisted twice with one id.
		const chat = createConfiguredChat("Test: wake single-copy");
		const seed = scriptedTeacher(() => [() => fauxAssistantMessage([fauxText("On it — dispatched the researcher.")])]);
		await drainTurn(post(chat.id, { type: "text", text: "research it" }), agentFactory(seed.engine));

		// Override the pump's turn runner for the scripted engine.
		const wake = scriptedTeacher(() => [() => fauxAssistantMessage([fauxText("Good research — building on it.")])]);
		setTurnRunner(async (chatId, input) => {
			const res = await handleChatInput(chatId, input, agentFactory(wake.engine));
			await res.arrayBuffer().catch(() => undefined);
			return res.status;
		});

		// A real job record: chatIdOf resolves the chat through the job store.
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-1" });
		const steer = buildSubagentSteer(
			job,
			{ brief: "The Mercury answer, with sources.", sources: [{ title: "NASA", url: "https://nasa.gov" }] },
		);
		// deliverJobResult resolves at claim time; wait for the wake to persist.
		await deliverJobResult(steer); // queue + pump → waitForIdle → the wake turn
		await waitFor(() => {
			const rec = chatStore.getChat(chat.id);
			const at = rec?.messages.findIndex((m) => (m as { id?: string }).id === steer.id) ?? -1;
			return at !== -1 && (rec!.messages[at + 1] as { role?: string } | undefined)?.role === "assistant";
		}, 8000, "the wake turn to persist (marker + response)");

		const record = chatStore.getChat(chat.id)!;
		const copies = record.messages.filter((m) => (m as { id?: string }).id === steer.id);
		assert.equal(copies.length, 1, "exactly ONE copy of the steer marker (the carried filter)");
	});

	it("Wave C steering: a mid-run result injects BETWEEN turn units — never splitting a toolCall from its toolResult", { timeout: 15000 }, async () => {
		// A subagent result must land BETWEEN turn units inside the live run
		// (pi's steering queue, drained at turn boundaries), never as a wake.
		const chat = createConfiguredChat("Test: mid-run steering");

		// Step 1 (gated): an unknown tool yields an error result without ending the run.
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let release2!: () => void;
		const gate2 = new Promise<void>((r) => (release2 = r));
		let jobIdMid = "";
		let jobFlippedMidTurn: string | undefined;
		const seen: string[] = [];
		const faux = createFauxCore({});
		faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage(
					[fauxToolCall("no_such_tool", { note: "x" }, { id: "call-mid" })],
					{ stopReason: "toolUse" },
				);
			},
			async (context) => {
				seen.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)).join("\n"));
				// The job must be flipped done at injection, not at turn settle.
				jobFlippedMidTurn = jobStore.getJob(jobIdMid)?.status;
				await gate2;
				return fauxAssistantMessage([fauxText("Folded the marker in.")]);
			},
		]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };

		// A wake here would be a bug: delivery must ride the live run.
		let wakes = 0;
		setTurnRunner(async () => {
			wakes++;
			return 200;
		});

		const res = handleChatRequest(post(chat.id, { type: "text", text: "teach" }), agentFactory(engine));
		await waitFor(() => isTurnRunning(chat.id), 8000, "the turn is live");

		// The result lands mid-run.
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-mid" });
		jobIdMid = job.id;
		jobStore.updateJob(job.id, { status: "done", result: { brief: "Mid-run brief.", sources: [] }, delivery: { kind: "result", status: "pending" } });
		const steer = buildSubagentSteer(job, { brief: "Mid-run brief.", sources: [] });
		const delivery = deliverJobResult(steer);
		await new Promise((r) => setTimeout(r, 300)); // vehicle 1 hands off
		assert.equal(wakes, 0, "no wake — the live run owns the delivery");

		release();
		await new Promise((r) => setTimeout(r, 150));
		release2();
		await drain(await res);
		await delivery; // resolves at settleSteers (the run persisted the marker)
		assert.equal(jobFlippedMidTurn, "done", "worker completion is independent of the streaming teacher turn");

		const record = chatStore.getChat(chat.id)!;
		const at = (role: string, pred: (m: LhMessage) => boolean) =>
			record.messages.findIndex((m) => (m as { role?: string }).role === role && pred(m as never));
		const callAt = record.messages.findIndex(
			(m) => (m as { role?: string }).role === "assistant" &&
				JSON.stringify((m as { content?: unknown }).content).includes("call-mid"),
		);
		const resultAt = at("toolResult", (m) => (m as { toolCallId?: string }).toolCallId === "call-mid");
		const steerAt = record.messages.findIndex((m) => (m as { id?: string }).id === steer.id);
		const finalAt = at("assistant", (m) => JSON.stringify((m as { content?: unknown }).content).includes("Folded the marker in."));
		assert.ok(callAt !== -1 && resultAt !== -1 && steerAt !== -1 && finalAt !== -1, `all units present: ${callAt}/${resultAt}/${steerAt}/${finalAt}`);
		assert.ok(callAt < resultAt, "the toolCall precedes its toolResult (bonded pair)");
		assert.equal(steerAt, resultAt + 1, "the marker injected at the turn boundary — immediately after the completed unit");
		assert.ok(steerAt < finalAt, "the run CONTINUED after the injection (same run, no wake)");
		assert.equal(record.messages.filter((m) => (m as { id?: string }).id === steer.id).length, 1, "exactly one marker copy");
		assert.ok(seen[0]!.includes("Mid-run brief."), "the model SAW the marker in its next prompt");
		assert.equal(wakes, 0, "delivery rode the live run end to end");
	});

	it("the view projection renders reasoning first regardless of content order", () => {
		const assistantWith = (content: unknown[]): LhMessage => ({
			role: "assistant", api: "openai-completions", provider: "openrouter", model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, timestamp: 1, id: "a1", stopReason: "toolUse", content,
		}) as never;
		const order = (content: unknown[]) => projectView([{ id: "u0", role: "user", content: "hi", timestamp: 1 } as never, assistantWith(content)])[1]!
			.parts.filter((p) => p.type !== "step-start").map((p) => p.type);
		const call = { type: "toolCall", id: "call-tr", name: "quiz", arguments: { question: "q", options: [{ label: "a" }], correctAnswer: "a", explanation: "" } };
		assert.deepEqual(order([{ type: "text", text: "Answer." }, { type: "thinking", thinking: "After." }, call]), ["reasoning", "text", "tool-quiz"]);
		assert.deepEqual(order([{ type: "thinking", thinking: "First." }, { type: "text", text: "Answer." }]), ["reasoning", "text"]);
	});

	it("a cancelled view NEVER aborts the turn — it runs to completion (owner ruling 2026-09-25)", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const engine = gatedTeacher(gate);
		const chat = createConfiguredChat("Test: view cancel");

		const res = await handleChatRequest(post(chat.id, { type: "text", text: "hold my turn" }), agentFactory(engine));
		// The POST acks and closes while the turn is still gated.
		assert.deepEqual(JSON.parse(await res.text()), { ok: true }, "the ack is a tiny JSON envelope");
		// Attach a view, read one chunk, then cancel.
		const view = new Response(runningTurn(chat.id)!.subscribe());
		const reader = view.body!.getReader();
		await reader.read();
		await reader.cancel();
		assert.equal(isTurnRunning(chat.id), true, "cancel detached the view only — the turn runs on");
		assert.ok(runningTurn(chat.id), "the running-turn registry still holds the handle");

		release();
		await waitFor(() => !isTurnRunning(chat.id), 8000, "turn settle after view cancel");
		const saved = chatStore.getChat(chat.id)!;
		assert.equal(saved.messages.length, 2, "complete turn persisted — not a partial");
		assert.equal(runningTurn(chat.id), undefined, "handle unregistered at settle");
	});

	it("an ungradeable quiz is rejected at the call boundary, the error reaches the model, and the model retries", async () => {
		const BAD_QUIZ_INPUT = { ...QUIZ_INPUT, correctAnswer: "mercury-slug" }; // matches no option
		const steps = (calls: string[][]): FauxResponseStep[] => [
			(context) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage([fauxToolCall("quiz", BAD_QUIZ_INPUT, { id: "call-bad" })], { stopReason: "toolUse" });
			},
			(context) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "call-good" })], { stopReason: "toolUse" });
			},
		];
		const { engine, calls } = scriptedTeacher(steps);
		const chat = createConfiguredChat("Test: bad quiz retry");
		const events = eventsOf(await drainTurn(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine)));

		// The dock mounts only on a CLEAN tool_execution_end.
		const endOf = (id: string) => events.find((e) => e.type === "tool_execution_end" && e.toolCallId === id);
		assert.equal(endOf("call-bad")?.isError, true);
		assert.equal(endOf("call-good")?.isError, false);
		assert.equal(calls.length, 2, "the invalid call triggered a second model prompt");
		assert.match(calls[1]!.join(" "), /does not match any option value/, "the validation error reached the model");

		const saved = chatStore.getChat(chat.id)!;
		assert.ok(projectView(saved.messages)[1]!.parts.some((p) => p.type === "tool-quiz" && (p as { state?: string }).state === "output-error"), "the failed call persists as an error result");
		assert.equal(danglingQuestionOf(saved.messages)?.toolCallId, "call-good", "the RETRIED quiz is the pending one");
	});

	it("parallel quiz calls are asked, saved, and answered in the model's call order", async () => {
		// The dock once showed the SECOND batched quiz first. Pins call order
		// on the wire (sequential execution), in the record, and in the dock.
		const QUIZ_A = { ...QUIZ_INPUT, question: "Quiz A: which planet is closest to the sun?" };
		const QUIZ_B = { ...QUIZ_INPUT, question: "Quiz B: which planet is largest?" };

		const { engine } = scriptedTeacher(() => [
			() =>
				fauxAssistantMessage(
					[fauxToolCall("quiz", QUIZ_A, { id: "call-a" }), fauxToolCall("quiz", QUIZ_B, { id: "call-b" })],
					{ stopReason: "toolUse" },
			),
		]);

		const chat = createConfiguredChat("Test: parallel quizzes");
		const body = await drainTurn(post(chat.id, { type: "text", text: "quiz me twice" }), agentFactory(engine));

		const events = eventsOf(body);
		const endA = events.findIndex((e) => e.type === "tool_execution_end" && e.toolCallId === "call-a" && e.isError === false);
		const endB = events.findIndex((e) => e.type === "tool_execution_end" && e.toolCallId === "call-b" && e.isError === false);
		assert.ok(endA !== -1 && endB !== -1, "both quizzes' clean ends are on the wire");
		assert.ok(endA < endB, "call A's end precedes call B's (sequential execution)");

		const saved = chatStore.getChat(chat.id)!;
		const quizIds = projectView(saved.messages)[1]!.parts
			.filter((p) => p.type === "tool-quiz")
			.map((p) => (p as { toolCallId: string }).toolCallId);
		assert.deepEqual(quizIds, ["call-a", "call-b"], "parts persisted in call order");

		const pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "call-a", "the FIRST asked question is the dock subject");
		const answered = [...saved.messages, newAnswerResult("call-a", "quiz", gradedAnswer(QUIZ_A, ["Mercury"]))];
		const next = danglingQuestionOf(answered);
		assert.equal(next?.toolCallId, "call-b", "the SECOND question becomes the dock subject only after the first is answered");
	});
});

describe("chat store", () => {
	it("persist the per-chat model settings (replace-whole, no updatedAt churn)", async () => {
		const chat = chatStore.createChat("Settings test"); createdChats.push(chat.id);
		const before = chatStore.getChat(chat.id)!.updatedAt;
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" });
		const saved = chatStore.getChat(chat.id)!;
		assert.deepEqual(saved.settings, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" });
		assert.equal(saved.updatedAt, before, "a picker write is not conversation activity");
		// replace-whole: an empty write clears the override
		chatStore.saveSettings(chat.id, {});
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, {});
	});
});

describe("canonical persistence failures", () => {
	it("refuses a failed input save without building an agent or leaving a live turn", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: failed answer write-ahead");
		await drainTurn(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine));
		const before = chatStore.getChat(chat.id)!.messages;
		const save = chatStore.saveMessages;
		let builds = 0;
		chatStore.saveMessages = () => { throw new Error("synthetic write-ahead failure"); };
		try {
			const res = await handleChatRequest(post(chat.id, { type: "answer", toolCallId: "call-1", answer: gradedAnswer(QUIZ_INPUT, ["Mercury"]) }), (opts) => {
				builds++;
				return agentFactory(engine)!(opts);
			});
			const running = runningTurn(chat.id);
			if (running) await new Response(running.subscribe()).text();
			assert.equal(res.status, 500);
			const client = new SessionModel({ chatId: chat.id, initialMessages: before, fetch: async () => res.clone() });
			await client.submitAnswer("quiz", "call-1", gradedAnswer(QUIZ_INPUT, ["Mercury"]));
			assert.equal(client.getState().error?.message, "Your input could not be saved. Please try again.");
			assert.equal(await res.text(), "Your input could not be saved. Please try again.");
			assert.equal(builds, 0);
			assert.equal(isTurnRunning(chat.id), false);
			assert.equal(runningTurn(chat.id), undefined);
			assert.deepEqual(chatStore.getChat(chat.id)!.messages, before);
		} finally { chatStore.saveMessages = save; }
	});

	it("reports a failed reply save before DONE while keeping the accepted answer durable", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: failed reply persistence");
		await drainTurn(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine));
		const save = chatStore.saveMessages;
		let writes = 0;
		chatStore.saveMessages = (id, messages) => {
			if (++writes === 2) throw new Error("synthetic reply save failure");
			return save(id, messages);
		};
		try {
			const body = await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer: gradedAnswer(QUIZ_INPUT, ["Mercury"]) }), agentFactory(engine));
			const errors = eventsOf(body).filter(e => e.type === "error");
			assert.equal(errors.length, 1);
			assert.equal(errors[0]!.errorText, "The reply could not be saved.");
			assert.ok(body.indexOf("The reply could not be saved.") < body.indexOf("[DONE]"));
			assert.equal(isTurnRunning(chat.id), false);
			assert.equal(runningTurn(chat.id), undefined);
			assert.equal(chatStore.getChat(chat.id)!.messages.at(-1)?.role, "toolResult");
			// The normal submitter may not reach GET /stream until AFTER the
			// failing turn has left the live registry. It must still see it.
			const late = await streamRoute.GET(new Request("http://test/stream"), { params: Promise.resolve({ id: chat.id }) });
			assert.equal(eventsOf(await late.text()).find(e => e.type === "error")?.errorText, "The reply could not be saved.");
			// An already-open idle view can miss both the start and the wire
			// error, then learn of settlement only via a record synchronization.
			const snapshot = await (await recordRoute.GET(new Request("http://test/record"), { params: Promise.resolve({ id: chat.id }) })).json();
			assert.equal(needsContinuation(snapshot.messages), true, "the durable answer alone looks like an owed continuation");
			let automaticPosts = 0;
			const missedView = new SessionModel({ chatId: chat.id, initialMessages: [], fetch: async () => {
				automaticPosts++;
				return new Response("unexpected automatic retry", { status: 500 });
			} });
			missedView.setMessages(snapshot.messages, snapshot.turnFailure ?? undefined);
			await missedView.continueIfOwed(snapshot.messages);
			assert.equal(automaticPosts, 0, "the record notice must block replacement even without a stream attachment");
			assert.equal(missedView.getState().error?.message, "The reply could not be saved.");
		} finally { chatStore.saveMessages = save; }
	});

	it("does not redeliver a persisted learner steer after usage bookkeeping fails", async () => {
		const { engine } = scriptedTeacher(() => [() => fauxAssistantMessage([fauxText("Synthetic response")])]);
		const chat = createConfiguredChat("Test: post-save bookkeeping failure");
		const steer = newUserMessage("Synthetic learner steer");
		const appendUsage = chatStore.appendTurnUsage;
		chatStore.appendTurnUsage = () => { throw new Error("synthetic usage write failure"); };
		try {
			const body = await drainTurn(post(chat.id, { type: "text", text: "go" }), opts => {
				const agent = createTeacherAgent(undefined, { engine, messages: opts.messages, onUsage: opts.onUsage });
				agent.subscribe(event => {
					if (event.type === "agent_start") assert.equal(steerLiveChat(chat.id, steer), true);
				});
				return agent;
			});
			assert.equal(eventsOf(body).find(e => e.type === "error")?.errorText, "An error occurred.");
			assert.ok(chatStore.getChat(chat.id)!.messages.some(m => m.id === steer.id), "the steer was saved before bookkeeping failed");
			const delivered: LhMessage[] = [];
			const next = { steer: (message: LhMessage) => delivered.push(message), state: { model: { provider: "faux" } } } as unknown as Parameters<typeof registerLiveAgent>[1];
			registerLiveAgent(chat.id, next);
			assert.deepEqual(delivered, [], "an already-saved learner steer must not reach another agent");
		} finally {
			chatStore.appendTurnUsage = appendUsage;
			unregisterLiveAgent(chat.id);
		}
	});
});

describe("mid-turn navigation (turn liveness + write-ahead)", () => {
	it("one turn per chat: a concurrent request is 409'd; the next one after finish is accepted", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: turn guard");

		const res1 = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine)); // acked; the turn runs as a background object (Diet B: no stream to hold)
		assert.equal(isTurnRunning(chat.id), true, "turn registered as in flight");
		const view1 = drainRunning(chat.id); // a live view — the turn would run on with none

		// A stale client (remount racing a live turn) tries to start a second turn.
		const res2 = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		assert.equal(res2.status, 409, "concurrent turn rejected — last-writer-wins persist would clobber it");

		await view1; // finish → onFinish → endTurn
		assert.equal(isTurnRunning(chat.id), false, "registry cleared at finish");

		const res3 = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		assert.equal(res3.status, 200, "the next turn is accepted after the previous finished");
		await drainRunning(chat.id);
	});

	it("write-ahead: the learner's answer is durable BEFORE the turn finishes", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: write-ahead");

		// Turn 1: the teacher asks the quiz (dangling call in the record).
		await drainTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));

		// The learner answers; the client posts the ANSWER EVENT.
		const answer = gradedAnswer(QUIZ_INPUT, ["Mercury"]);

		// NOT drained: the teacher turn is streaming, but the answer is already
		// on disk — a remount (or crash) mid-turn sees the answered quiz, never
		// the stale pre-answer question.
		assert.equal((await handleChatRequest(post(chat.id, { type: "answer", toolCallId: "call-1", answer }), agentFactory(engine))).status, 200);
		const midTurn = chatStore.getChat(chat.id)!;
		assert.equal(midTurn.messages.length, 3, "write-ahead appended the answer tool result before finish");
		assert.equal((midTurn.messages[2] as { role?: string }).role, "toolResult");

		await drainRunning(chat.id); // finish → persist the full turn → endTurn
		const saved2 = chatStore.getChat(chat.id)!;
		// Native: user, assistant, answer result, reaction — one append-only history.
		assert.equal(saved2.messages.length, 4, "full turn persisted as usual at finish");
		assert.equal(isTurnRunning(chat.id), false, "registry cleared at finish");
	});
});

describe("renameChat", () => {
	it("trims, persists without bumping updatedAt, and floors whitespace to Untitled session", () => {
		const chat = chatStore.createChat("old title"); createdChats.push(chat.id);
		const before = chatStore.getChat(chat.id)!.updatedAt;
		assert.equal(chatStore.renameChat(chat.id, "  new title  ").title, "new title");
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, before, "a rename is not conversation activity");
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)!.title, "new title");
		assert.equal(chatStore.renameChat(chat.id, "   ").title, "Untitled session");
	});
});

describe("the BYOK turn gate", () => {
	it("a chat with no model refuses the turn with the 503 envelope — nothing lingers", async () => {
		const chat = chatStore.createChat("Test: unconfigured chat"); createdChats.push(chat.id);

		// Read the resolved strong slot; a record-carried one legitimately opens the gate.
		const expectRefusal = effectiveSettings().models.strong === null;

		const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(scriptedTeacher(defaultLesson).engine));

		if (expectRefusal) {
			assert.equal(res.status, 503, "the universal turn gate refuses before beginTurn");
			const body = (await res.json()) as { error: string; code: string; missing: string[] };
			assert.equal(body.code, "models_not_configured");
			assert.deepEqual(body.missing, ["strong"]);
			assert.equal(isTurnRunning(chat.id), false, "the refusal never registers a live turn");
			assert.equal(chatStore.getChat(chat.id)!.messages.length, 0, "no write-ahead persist before the gate");
		} else {
			assert.equal(res.status, 200, "the record's strong slot satisfies the conversation chain");
			await drainRunning(chat.id);
		}
	});
});

describe("the key-presence turn gate", () => {
	it("a pinned provider whose key is gone refuses with 503 provider_key_missing — nothing lingers", async () => {
		const chat = chatStore.createChat("Test: keyless provider"); createdChats.push(chat.id);
		const saved = process.env.TOGETHER_API_KEY;
		delete process.env.TOGETHER_API_KEY;
		try {
			// The gate fires before the engine build, so the fake model id never hits the catalog.
			chatStore.saveSettings(chat.id, { model: { provider: "together", id: "no-such-model" } });
			const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me something" }), agentFactory(scriptedTeacher(defaultLesson).engine));

			assert.equal(res.status, 503, "the key-presence gate refuses before beginTurn");
			const body = (await res.json()) as { error: string; code: string; provider: string; slots: string[] };
			assert.equal(body.code, "provider_key_missing");
			assert.equal(body.provider, "together", "the envelope names whose key is gone");
			assert.deepEqual(body.slots, ["strong"], "the conversation tier is the affected slot");
			assert.equal(isTurnRunning(chat.id), false, "the refusal never registers a live turn");
			assert.equal(chatStore.getChat(chat.id)!.messages.length, 0, "no write-ahead persist before the gate");
		} finally {
			if (saved !== undefined) process.env.TOGETHER_API_KEY = saved;
		}
	});
});

describe("background-turn runner (every turn is a server-side process; clients are views)", () => {
	it("subscribe mid-turn: a second view gets the FULL replay, then live, same dialect", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const engine = gatedTeacher(gate);
		const chat = createConfiguredChat("Test: reattach replay");

		const ack = await handleChatRequest(post(chat.id, { type: "text", text: "hold my turn" }), agentFactory(engine));
		assert.equal(ack.status, 200);
		// The first view consumes a little of the reattach wire.
		const firstHandle = runningTurn(chat.id)!;
		const firstView = new Response(firstHandle.subscribe());
		const reader = firstView.body!.getReader();
		await reader.read();

		// A SECOND view attaches mid-turn — a remount, another device.
		const handle = runningTurn(chat.id)!;
		assert.ok(handle, "the registry resolves the live turn");
		const secondText = new Response(handle.subscribe()).text();

		// Let the turn finish; both views close at settle.
		release();
		const text = await secondText;
		const replay = eventsOf(text);
		assert.equal(replay[0]!.type, "agent_start", "replay starts from the very first event");
		assert.ok(text.includes("Gated reply."), "replay carries the full streamed content");
		assert.ok(text.endsWith("data: [DONE]\n\n"), "live tail ends with the SSE terminal, same dialect as POST");
		// The first view also closes cleanly.
		const decoder = new TextDecoder();
		let firstTail = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			firstTail += decoder.decode(value, { stream: true });
		}
		assert.ok(firstTail.endsWith("data: [DONE]\n\n"), "first view closes cleanly at settle, unaffected by the reattach");
	});

	it("chunk bursts coalesce to ONE message_update on the wire, carrying the latest full snapshot", async () => {
		// message_update is a full snapshot per chunk; retaining each one made
		// memory and replay quadratic in message length.
		const long = "quadratic blowup ".repeat(40); // ~40 faux chunks
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText(long)])]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const chat = createConfiguredChat("Test: compaction law");
		const body = await drainTurn(post(chat.id, { type: "text", text: "go" }), agentFactory(engine));
		const events = eventsOf(body);
		const updates = events.filter((e) => e.type === "message_update");
		assert.equal(updates.length, 1, "a burst of chunks coalesces to exactly one update on the wire");
		assert.ok(
			JSON.stringify(updates[0]!.message?.content ?? []).includes(long),
			"the one update is the LATEST snapshot — the full streamed text",
		);
		const record = chatStore.getChat(chat.id)!;
		assert.ok(JSON.stringify(record.messages).includes(long), "persistTurn wrote the settled message in full");
	});

	it("remote abort: any client can stop a running turn; the partial persists; subscribers close cleanly", async () => {
		const engine = abortableTeacher();
		const chat = createConfiguredChat("Test: remote abort");

		const res = await handleChatRequest(post(chat.id, { type: "text", text: "wait forever" }), agentFactory(engine));
		assert.equal(res.status, 200);
		assert.ok(runningTurn(chat.id), "turn registered while in flight");
		const viewText = new Response(runningTurn(chat.id)!.subscribe()).text(); // the first view, reading to settle

		const outcome = abortTurn(chat.id);
		assert.deepEqual(outcome, { ok: true }, "abort resolves ok on a live turn");

		const text = await viewText;
		assert.ok(text.endsWith("data: [DONE]\n\n"), "subscriber closes cleanly at the aborted settle");

		await waitFor(() => !isTurnRunning(chat.id), 8000, "aborted turn settle");
		const saved = chatStore.getChat(chat.id)!;
		assert.ok(saved.messages.length >= 2, "the partial transcript persisted via the usual settle path");
		assert.equal(runningTurn(chat.id), undefined, "handle unregistered after the aborted settle");

		assert.deepEqual(abortTurn(chat.id), { ok: false, reason: "not_running" }, "second abort is not_running");
	});

	it("subscribe after settle: the cheap terminal tells the client the record is current", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: settled terminal");

		const term = settledTurnResponse();
		assert.equal(await term.text(), 'data: {"type":"turn-settled"}\n\ndata: [DONE]\n\n', "terminal is one event + [DONE]");
		assert.equal(runningTurn(chat.id), undefined);

		await drainTurn(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine));
		assert.equal(runningTurn(chat.id), undefined, "no handle survives settle");
	});
});

it("explain tool call persists as a pending part; the free-text answer reveals the commitment and reaches the model", async () => {
	const EXPLAIN_INPUT = {
		question: "Explain why Mercury is hard to observe.",
		correctAnswer: "Its small angular separation from the Sun — it never strays far from the Sun in our sky.",
		nodeId: "planet-order",
		type: "check",
	};
	const { engine, calls } = scriptedTeacher((cs) => [
		(context) => {
			cs.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage(
				[fauxThinking("Free recall this time."), fauxToolCall("explain", EXPLAIN_INPUT, { id: "call-1" })],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			cs.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage([fauxText("Right — it hugs the Sun.")]);
		},
	]);
	const chat = createConfiguredChat("Test: explain mechanic");
	const tools = createTeacherTools({ chatId: chat.id, chatStore, jobStore, spawn: () => {} }, { explain: true });
	assert.ok(tools.explain && !tools.quiz, "explain armed, quiz dropped — one quizzing tool");
	const factory: Parameters<typeof handleChatRequest>[1] = (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages, tools });
	await drainTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), factory);

	const pending = danglingQuestionOf(chatStore.getChat(chat.id)!.messages);
	assert.equal(pending?.tool, "explain");
	assert.deepEqual(pending?.input, EXPLAIN_INPUT);

	const qd: QuestionData = {
		id: "call-1",
		kind: "explain",
		question: EXPLAIN_INPUT.question,
		mode: "text",
		options: [],
		committedAnswer: EXPLAIN_INPUT.correctAnswer,
		createdAt: new Date().toISOString(),
	};
	const answer = buildAnswer(qd, { text: "It stays near the Sun." });
	assert.equal(answer.correct, undefined, "no client grading — the model grades");
	await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer }), factory);

	const saved2 = chatStore.getChat(chat.id)!;
	const part = projectView(saved2.messages)[1]!.parts.find((p) => p.type === "tool-explain") as { state?: string; output?: { committed?: string } };
	assert.equal(part.state, "output-available");
	assert.equal(part.output?.committed, EXPLAIN_INPUT.correctAnswer, "the commitment snapshots into the answer record");

	// The continuation saw the learner's text and the commitment snapshot.
	const seen = calls[1]!.join("\n");
	assert.match(seen, /It stays near the Sun\./);
	assert.match(seen, /small angular separation/);
	assert.equal(danglingQuestionOf(saved2.messages), null, "no pending question remains");
});

describe("the silent dismissal (A2)", () => {
	it("writes the toolResult with NO wake — the next plain message carries it to the model", async () => {
		const { engine, calls } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: silent dismissal");

		await drainTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		assert.ok(danglingQuestionOf(chatStore.getChat(chat.id)!.messages), "the quiz is pending");

		const res = await dismissPost(chat.id, "call-1");
		assert.equal(res.status, 200);
		const saved = chatStore.getChat(chat.id)!;
		assert.equal(danglingQuestionOf(saved.messages), null, "the call is answered by the dismissal");
		const tail = saved.messages[saved.messages.length - 1]! as { role?: string; details?: { dismissed?: boolean } };
		assert.equal(tail.role, "toolResult");
		assert.equal(tail.details?.dismissed, true, "the record's dismissal is the details payload");
		assert.equal(calls.length, 1, "NO second engine call — the dismissal woke nothing");
		assert.equal(isTurnRunning(chat.id), false);
		assert.equal(endsInDismissal(saved.messages), true, "the session sits dismissal-paused");

		// The next plain message is the wake and carries the dismissed result.
		await drainTurn(post(chat.id, { type: "text", text: "skip that — tell me about Mars" }), agentFactory(engine));
		assert.equal(calls.length, 2, "exactly one wake: the user's message");
		assert.match(calls[1]!.join("\n"), /dismissed/, "the dismissed result rode the wake's context");
		assert.equal(endsInDismissal(chatStore.getChat(chat.id)!.messages), false, "the pause lifted with the send");
	});

	it("rejects honestly: unknown chat 404, no dangling question 400", async () => {
		assert.equal((await dismissPost("chat_nonexistent", "call-x")).status, 404);
		const chat = createConfiguredChat("Test: dismiss no question");
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "hi", timestamp: 1 } as never]);
		assert.equal((await dismissPost(chat.id, "call-x")).status, 400);
	});
});

describe("parallel question calls: the LAST resolution decides the wake", () => {
	const ASK_INPUT = { question: "Next topic?", options: [{ label: "Chemistry" }, { label: "History" }] };

	/** Turn 1: quiz + ask in one assistant message. Turn 2: the reaction. */
	function batchLesson(calls: string[][]): FauxResponseStep[] {
		return [
			(context) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage(
					[fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" }), fauxToolCall("ask_user_question", ASK_INPUT, { id: "call-2" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage([fauxText("Both answered — good.")]);
			},
		];
	}

	it("the sibling answer wakes NOTHING; the last answer fires the one turn with both results adjacent", async () => {
		const { engine, calls } = scriptedTeacher(batchLesson);
		const chat = createConfiguredChat("Test: parallel questions");

		await drainTurn(post(chat.id, { type: "text", text: "ask me two questions in parallel" }), agentFactory(engine));
		let saved = chatStore.getChat(chat.id)!;
		let pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "call-1", "the dock holds the quiz first");

		// The sibling answer appends adjacent to the batch and wakes nothing.
		const quizAns = gradedAnswer(QUIZ_INPUT, ["Mercury"]);
		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer: quizAns }), agentFactory(engine));
		assert.equal(calls.length, 1, "the sibling answer woke NOTHING (the gate deferred)");
		saved = chatStore.getChat(chat.id)!;
		assert.equal((saved.messages[2] as { toolCallId?: string }).toolCallId, "call-1", "quiz result adjacent to the batch");
		pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "call-2", "the dock advances to the ask immediately — no turn ran");

		const askAns = {
			kind: "ask",
			questionText: ASK_INPUT.question,
			dontKnow: false,
			answers: [],
			text: "History",
			answeredAt: new Date().toISOString(),
		};
		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-2", answer: askAns }), agentFactory(engine));
		assert.equal(calls.length, 2, "exactly one wake: the last answer's turn");
		saved = chatStore.getChat(chat.id)!;
		assert.equal(danglingQuestionOf(saved.messages), null, "nothing dangles anymore");
		const prompt2 = calls[1]!.join("\n");
		assert.match(prompt2, /Mercury/, "the quiz result rode the wake's context");
		assert.match(prompt2, /History/, "the ask answer rode the wake's context");
		const roles = saved.messages.map((m) => (m as { role?: string }).role);
		assert.deepEqual(roles.slice(1, 5), ["assistant", "toolResult", "toolResult", "assistant"], "batch → both results → reaction");
	});

	it("round 1 — answer then dismiss: NO wake at all (ending on a dismissal pauses)", async () => {
		const { engine, calls } = scriptedTeacher(batchLesson);
		const chat = createConfiguredChat("Test: round 1");
		await drainTurn(post(chat.id, { type: "text", text: "two questions please" }), agentFactory(engine));

		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer: gradedAnswer(QUIZ_INPUT, ["Mercury"]) }), agentFactory(engine));
		assert.equal(calls.length, 1, "the sibling answer deferred");

		// The LAST resolution is a dismissal: no continuation may fire.
		assert.equal((await dismissPost(chat.id, "call-2", "ask")).status, 200);
		const saved = chatStore.getChat(chat.id)!;
		assert.equal(danglingQuestionOf(saved.messages), null);
		assert.equal(needsContinuation(saved.messages), false, "ending on a dismissal owes nothing");
		assert.equal(endsInDismissal(saved.messages), true, "the session sits paused");
		assert.equal(calls.length, 1, "NO wake — the agent never ran a second turn");
	});

	it("round 2 — dismiss then answer: exactly one wake carrying both results", async () => {
		const { engine, calls } = scriptedTeacher(batchLesson);
		const chat = createConfiguredChat("Test: round 2");
		await drainTurn(post(chat.id, { type: "text", text: "two questions please" }), agentFactory(engine));

		assert.equal((await dismissPost(chat.id, "call-1")).status, 200);
		assert.equal(calls.length, 1, "the dismissal woke nothing");
		assert.equal(danglingQuestionOf(chatStore.getChat(chat.id)!.messages)?.toolCallId, "call-2", "the dock advances to the next question");

		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-2", answer: { kind: "ask", questionText: "Next topic?", dontKnow: false, answers: [], text: "Chemistry", answeredAt: new Date().toISOString() } }), agentFactory(engine));
		assert.equal(calls.length, 2, "the trailing answer fired the one wake");
		const prompt2 = calls[1]!.join("\n");
		assert.match(prompt2, /Chemistry/, "the answer rode the wake");
		assert.match(prompt2, /dismissed/, "the dismissal rode the wake too");
	});
});

describe("composer steering: POST /api/chats/[id]/steer", () => {
	const steerPost = (chatId: string, body: unknown): Promise<Response> =>
		steerRoute.POST(
			new Request(`http://test/api/chats/${chatId}/steer`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
			{ params: Promise.resolve({ id: chatId }) },
		);

	it("honest rejections: 404 unknown chat, 400 bad input, 409 when no turn is live", async () => {
		const chat = createConfiguredChat("Test: steer rejections");
		assert.equal((await steerPost("chat_nope", { input: { type: "steer", id: "steer_1", text: "hi" } })).status, 404);
		assert.equal((await steerPost(chat.id, { input: { type: "steer", id: "", text: "hi" } })).status, 400);
		assert.equal((await steerPost(chat.id, { input: { type: "text", text: "hi" } })).status, 400);
		assert.equal((await steerPost(chat.id, { input: { type: "steer", id: "steer_1", text: "  " } })).status, 400);
		assert.equal((await steerPost(chat.id, { input: { type: "steer", id: "steer_1", text: "hi" } })).status, 409);
	});

	it("200 + the live steering queue when a turn runs; the drain lands the card and the model sees it", async () => {
		// The gated first call holds the turn open so the steer lands mid-run.
		const calls: string[][] = [];
		let release!: () => void;
		const gate = new Promise<void>((res) => (release = res));
		const faux = createFauxCore({});
		faux.setResponses([
			async (context: { messages: unknown[] }) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				await gate;
				return fauxAssistantMessage([fauxText("Teaching the solar system…")]);
			},
			(context: { messages: unknown[] }) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage([fauxText("Steered — covering Venus too.")]);
			},
		]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };

		const chat = createConfiguredChat("Test: steer live");

		const turnRes = await handleChatRequest(post(chat.id, { type: "text", text: "teach me" }), agentFactory(engine as never));
		await waitFor(() => calls.length === 1, 8000, "first model call started");

		const res = await steerPost(chat.id, { input: { type: "steer", id: "steer_live1", text: "also cover Venus" } });
		assert.equal(res.status, 200);

		// Attach before releasing.
		const viewText = drainRunning(chat.id);
		release(); // the first response completes → the drain → the second call
		const body = await viewText;
		assert.match(body, /also cover Venus/, "the drained steer rode the live stream verbatim");

		assert.equal(calls.length, 2, "still one run — the steer continued it, not a new turn");
		assert.match(calls[1]!.join("\n"), /also cover Venus/, "the model saw the steer in its context");

		const saved = chatStore.getChat(chat.id)!;
		const roles = saved.messages.map((m) => (m as { role?: string }).role);
		assert.deepEqual(roles, ["user", "assistant", "user", "assistant"], "text → teaching → STEER → steered reply");
		assert.equal((saved.messages[2] as { id?: string }).id, "steer_live1", "the client-minted id survived to the record");
	});
});

// Providers that reset tool-call ids per response (`call_0` every turn) once
// corrupted the fold and answer routing; the wire boundary now remints collisions.
describe("duplicate provider tool-call ids (the Lacan fix)", () => {
	it("every `call_0` turn keeps its identity: ask answered as ask, quiz as quiz, ids unique in the record", async () => {
		const ASK = { question: "What do you want from Lacan?" };
		const QUIZ2 = { ...QUIZ_INPUT, type: "check" };
		const { engine } = scriptedTeacher(() => [
			() => fauxAssistantMessage([fauxText("First — your goal?"), fauxToolCall("ask_user_question", ASK, { id: "call_0" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("The unconscious, then."), fauxToolCall("quiz", QUIZ2, { id: "call_0" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Right — and that is where Lacan begins.")]),
		]);

		const chat = createConfiguredChat("Lacan: duplicate call_0 turns");
		await drainTurn(post(chat.id, { type: "text", text: "teach me Lacan" }), agentFactory(engine));
		let saved = chatStore.getChat(chat.id)!;
		let pending = danglingQuestionOf(saved.messages)!;
		assert.equal(pending.tool, "ask_user_question");
		const askId = pending.toolCallId;
		await drainTurn(post(chat.id, { type: "answer", toolCallId: askId, answer: { kind: "ask", questionText: ASK.question, dontKnow: false, answers: [], text: "The theory core", answeredAt: new Date().toISOString() }, }), agentFactory(engine));

		saved = chatStore.getChat(chat.id)!;
		pending = danglingQuestionOf(saved.messages)!;
		assert.equal(pending.tool, "quiz");
		const quizId = pending.toolCallId;
		assert.notEqual(quizId, askId, "the uniquifier reminted the colliding id at the wire boundary");
		await drainTurn(post(chat.id, { type: "answer", toolCallId: quizId, answer: gradedAnswer(QUIZ2, ["Mercury"]) }), agentFactory(engine));

		saved = chatStore.getChat(chat.id)!;
		// Call ids are unique among themselves (a call and its result share one id).
		const callIds = saved.messages.flatMap((m) => m.role === "assistant" ? (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => c.id) : []);
		assert.equal(callIds.length, 2);
		assert.equal(new Set(callIds).size, 2, "no duplicate tool-call ids persist");

		// Each card keeps its own answer — no overwrite.
		const view = projectView(saved.messages);
		const parts = view.flatMap((v) => v.parts).filter((p) => p.type.startsWith("tool-"));
		const askPart = parts.find((p) => (p as { toolCallId?: string }).toolCallId === askId) as { state?: string; output?: { kind?: string } };
		const quizPart = parts.find((p) => (p as { toolCallId?: string }).toolCallId === quizId) as { state?: string; output?: { kind?: string } };
		assert.equal(askPart?.state, "output-available");
		assert.equal(askPart?.output?.kind, "ask", "the ask card keeps its own answer");
		assert.equal(quizPart?.state, "output-available");
		assert.equal(quizPart?.output?.kind, "quiz", "the quiz card got ITS answer (the pre-fix bug: it landed on the ask card)");
	});
});
