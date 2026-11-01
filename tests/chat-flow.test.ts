/**
 * Scripted integration test — the full teacher loop with zero tokens, driving
 * handleChatRequest directly with pi-ai's faux provider.
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
	type AssistantMessage,
	type FauxContentBlock,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { handleChatInput, handleChatRequest } from "../src/server/chat-handler.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { deliverJobResult, registerLiveAgent, setTurnRunner, steerLiveChat, unregisterLiveAgent } from "../src/server/jobs.ts";
import { SessionModel } from "../components/session-core.ts";
import { buildSubagentSteer } from "../src/core/contracts.ts";
import { abortTurn, runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { buildAnswer, dismissedAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { danglingQuestionOf, endsInDismissal, needsContinuation, newAnswerResult, newUserMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { PATHS } from "../config.ts";

const dismissRoute = await import("../server/routes/chats/[id]/dismiss/route.ts");
const steerRoute = await import("../server/routes/chats/[id]/steer/route.ts");
const streamRoute = await import("../server/routes/chats/[id]/stream/route.ts");
const recordRoute = await import("../server/routes/chats/[id]/route.ts");

// The key-presence turn gate reads env-first truth.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

type Reply = AssistantMessage;
const promptOf = (context: { messages: readonly unknown[] }) => context.messages.map((m) => JSON.stringify((m as { content: unknown }).content));

/** A response step that records the prompt it saw, then replies. */
function recorded(calls: string[][], reply: () => Reply): FauxResponseStep {
	return (context) => {
		calls.push(promptOf(context));
		return reply();
	};
}

const toolUse = (...content: FauxContentBlock[]) => fauxAssistantMessage(content, { stopReason: "toolUse" });

const askAnswer = (questionText: string, text: string) => ({ kind: "ask", questionText, dontKnow: false, answers: [], text, answeredAt: new Date().toISOString() });

function engineOf(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A scripted engine whose replies all record the prompt they saw. */
function scriptedTeacher(replies: Array<() => Reply>): { engine: PiEngine; calls: string[][] } {
	const calls: string[][] = [];
	return { engine: engineOf(replies.map((r) => recorded(calls, r))), calls };
}

/** The default two-turn lesson: probe quiz, then react to the answer. */
const defaultLesson = () =>
	scriptedTeacher([
		() => toolUse(fauxThinking("Probe the basics first."), fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" })),
		() => fauxAssistantMessage([fauxText("Right — Mercury it is.")]),
	]);

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
const mercury = () => gradedAnswer(QUIZ_INPUT, ["Mercury"]);

function eventsOf(body: string): Array<Record<string, any>> {
	return body
		.split("\n")
		.filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
		.map((line) => JSON.parse(line.slice(6)));
}

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	return res.text();
}

/** POST /api/chat acks and closes; drain the turn through the reattach stream. */
async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<string> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (!handle) return ""; // a short turn may settle inside the handler's awaits
	return new Response(handle.subscribe()).text();
}

async function drainRunning(chatId: string): Promise<string> {
	const handle = runningTurn(chatId);
	if (!handle) assert.fail(`no running turn to drain: ${chatId}`);
	return new Response(handle.subscribe()).text();
}

function waitFor(cond: () => boolean, what = "condition", timeoutMs = 8000): Promise<void> {
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

function gate(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((r) => (release = r));
	return { promise, release };
}

/** A teacher whose only step blocks on a gate — a turn held mid-run. */
const gatedTeacher = (held: Promise<void>): PiEngine =>
	engineOf([
		async () => {
			await held;
			return fauxAssistantMessage([fauxText("Gated reply.")]);
		},
	]);

/** A teacher that NEVER resolves except on abort. */
const abortableTeacher = (): PiEngine =>
	engineOf([
		((_ctx: unknown, opts: { signal?: AbortSignal } | undefined) =>
			new Promise((resolve) => {
				const sig = opts?.signal;
				if (sig?.aborted) return resolve(fauxAssistantMessage("late"));
				sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
			})) as unknown as FauxResponseStep,
	]);

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

function routePost(route: { POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> }, chatId: string, body: unknown): Promise<Response> {
	return route.POST(
		new Request(`http://test/api/chats/${chatId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		{ params: Promise.resolve({ id: chatId }) },
	);
}

const dismissPost = (chatId: string, toolCallId: string, kind: "quiz" | "ask" = "quiz") =>
	routePost(dismissRoute, chatId, { input: { type: "dismiss", toolCallId, answer: dismissedAnswer(kind, kind === "ask" ? "Next topic?" : QUIZ_INPUT.question) } });

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
});

/** BYOK turn gate: every scripted chat needs a per-chat model pin. */
function createConfiguredChat(title: string) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(chat.id, { nodes: [{ id: "planet-order", title: "Planet order" }], edges: [], version: 1 });
	return chat;
}

const roleOf = (m: unknown) => (m as { role?: string } | undefined)?.role;
const idOf = (m: unknown) => (m as { id?: string } | undefined)?.id;

describe("teacher chat flow (scripted model)", () => {
	it("quiz tool call persists as a pending part; the answer continues the lesson", async () => {
		const { engine, calls } = defaultLesson();
		const chat = createConfiguredChat("Test: solar system");

		const events = eventsOf(await drainTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine)));
		const callSeen = events.findIndex((e) => e.type === "message_update" && JSON.stringify(e.message?.content ?? []).includes('"type":"toolCall"'));
		const execStart = events.findIndex((e) => e.type === "tool_execution_start" && e.toolCallId === "call-1");
		const execEnd = events.findIndex((e) => e.type === "tool_execution_end" && e.toolCallId === "call-1");
		assert.ok(callSeen !== -1 && callSeen < execStart && execStart < execEnd, "partial → execution start → execution end");
		assert.equal(events[execEnd]!.isError, false);

		const saved1 = chatStore.getChat(chat.id)!;
		assert.equal(saved1.messages.length, 2, "the clean question's placeholder result never persists");
		const pending = danglingQuestionOf(saved1.messages);
		assert.equal(pending?.toolCallId, "call-1");
		assert.deepEqual(pending?.input, QUIZ_INPUT);

		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer: mercury() }), agentFactory(engine));

		const saved2 = chatStore.getChat(chat.id)!;
		assert.equal(saved2.messages.length, 4);
		assert.equal(roleOf(saved2.messages[2]), "toolResult", "the graded answer is the call's tool result");
		const answeredQuiz = projectView(saved2.messages)[1]!.parts.find((p) => p.type === "tool-quiz") as { state?: string; output?: { correct?: boolean } };
		assert.equal(answeredQuiz.state, "output-available");
		assert.equal(answeredQuiz.output?.correct, true);
		assert.equal(calls.length, 2);
		assert.match(calls[1]!.join(" "), /Mercury/, "continuation prompt carries the tool result");
		assert.equal(danglingQuestionOf(saved2.messages), null);
	});

	it("refuses unknown chats (404) and malformed inputs (400) — no liveness effects, no lockout", async () => {
		assert.equal((await handleChatRequest(post("chat_nonexistent", { type: "text", text: "hi" }))).status, 404);
		const chat = createConfiguredChat("Test: malformed input");
		const factory = () => agentFactory(defaultLesson().engine);
		for (const input of [{ type: "text" }, { type: "answer", toolCallId: "call-none", answer: { correct: true } }]) {
			assert.equal((await handleChatRequest(post(chat.id, input), factory())).status, 400);
			assert.equal(isTurnRunning(chat.id), false);
		}
		await drain(await handleChatRequest(post(chat.id, { type: "text", text: "teach me" }), factory()));
	});

	it("a pump-fired wake turn never double-appends its steer", { timeout: 15000 }, async () => {
		const chat = createConfiguredChat("Test: wake single-copy");
		await drainTurn(post(chat.id, { type: "text", text: "research it" }), agentFactory(scriptedTeacher([() => fauxAssistantMessage([fauxText("Dispatched.")])]).engine));

		const wake = scriptedTeacher([() => fauxAssistantMessage([fauxText("Building on it.")])]);
		setTurnRunner(async (chatId, input) => {
			const res = await handleChatInput(chatId, input, agentFactory(wake.engine));
			await res.arrayBuffer().catch(() => undefined);
			return res.status;
		});

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-1" });
		const steer = buildSubagentSteer(job, { brief: "The Mercury answer.", sources: [{ title: "NASA", url: "https://nasa.gov" }] });
		await deliverJobResult(steer);
		await waitFor(() => {
			const rec = chatStore.getChat(chat.id);
			const at = rec?.messages.findIndex((m) => idOf(m) === steer.id) ?? -1;
			return at !== -1 && roleOf(rec!.messages[at + 1]) === "assistant";
		}, "the wake turn to persist");

		assert.equal(chatStore.getChat(chat.id)!.messages.filter((m) => idOf(m) === steer.id).length, 1);
	});

	it("a mid-run result injects BETWEEN turn units — never splitting a toolCall from its toolResult, never a wake", { timeout: 15000 }, async () => {
		const chat = createConfiguredChat("Test: mid-run steering");
		const g1 = gate();
		const g2 = gate();
		let jobIdMid = "";
		let jobFlippedMidTurn: string | undefined;
		const seen: string[] = [];
		const engine = engineOf([
			async () => {
				await g1.promise;
				// An unknown tool yields an error result without ending the run.
				return toolUse(fauxToolCall("no_such_tool", { note: "x" }, { id: "call-mid" }));
			},
			async (context) => {
				seen.push(promptOf(context).join("\n"));
				jobFlippedMidTurn = jobStore.getJob(jobIdMid)?.status;
				await g2.promise;
				return fauxAssistantMessage([fauxText("Folded the marker in.")]);
			},
		]);

		let wakes = 0;
		setTurnRunner(async () => {
			wakes++;
			return 200;
		});

		const res = handleChatRequest(post(chat.id, { type: "text", text: "teach" }), agentFactory(engine));
		await waitFor(() => isTurnRunning(chat.id), "the turn is live");

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-mid" });
		jobIdMid = job.id;
		jobStore.updateJob(job.id, { status: "done", result: { brief: "Mid-run brief.", sources: [] }, delivery: { kind: "result", status: "pending" } });
		const steer = buildSubagentSteer(job, { brief: "Mid-run brief.", sources: [] });
		const delivery = deliverJobResult(steer);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(wakes, 0, "no wake — the live run owns the delivery");

		g1.release();
		await new Promise((r) => setTimeout(r, 150));
		g2.release();
		await drain(await res);
		await delivery;
		assert.equal(jobFlippedMidTurn, "done", "the job flips done at injection, not at turn settle");

		const msgs = chatStore.getChat(chat.id)!.messages;
		const has = (m: unknown, text: string) => JSON.stringify((m as { content?: unknown }).content).includes(text);
		const callAt = msgs.findIndex((m) => roleOf(m) === "assistant" && has(m, "call-mid"));
		const resultAt = msgs.findIndex((m) => roleOf(m) === "toolResult" && (m as { toolCallId?: string }).toolCallId === "call-mid");
		const steerAt = msgs.findIndex((m) => idOf(m) === steer.id);
		const finalAt = msgs.findIndex((m) => roleOf(m) === "assistant" && has(m, "Folded the marker in."));
		assert.ok(callAt !== -1 && callAt < resultAt, "the toolCall precedes its toolResult");
		assert.equal(steerAt, resultAt + 1, "the marker injected immediately after the completed unit");
		assert.ok(steerAt < finalAt, "the run continued after the injection");
		assert.equal(msgs.filter((m) => idOf(m) === steer.id).length, 1);
		assert.ok(seen[0]!.includes("Mid-run brief."), "the model saw the marker");
		assert.equal(wakes, 0);
	});

	it("a cancelled view NEVER aborts the turn — it runs to completion (owner ruling 2026-09-25)", async () => {
		const g = gate();
		const chat = createConfiguredChat("Test: view cancel");

		const res = await handleChatRequest(post(chat.id, { type: "text", text: "hold my turn" }), agentFactory(gatedTeacher(g.promise)));
		assert.deepEqual(JSON.parse(await res.text()), { ok: true });
		const reader = new Response(runningTurn(chat.id)!.subscribe()).body!.getReader();
		await reader.read();
		await reader.cancel();
		assert.equal(isTurnRunning(chat.id), true, "cancel detached the view only");

		g.release();
		await waitFor(() => !isTurnRunning(chat.id), "turn settle after view cancel");
		assert.equal(chatStore.getChat(chat.id)!.messages.length, 2, "complete turn persisted");
		assert.equal(runningTurn(chat.id), undefined);
	});

	it("an ungradeable quiz is rejected at the call boundary, the error reaches the model, and the model retries", async () => {
		const { engine, calls } = scriptedTeacher([
			() => toolUse(fauxToolCall("quiz", { ...QUIZ_INPUT, correctAnswer: "mercury-slug" }, { id: "call-bad" })),
			() => toolUse(fauxToolCall("quiz", QUIZ_INPUT, { id: "call-good" })),
		]);
		const chat = createConfiguredChat("Test: bad quiz retry");
		const events = eventsOf(await drainTurn(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine)));

		const endOf = (id: string) => events.find((e) => e.type === "tool_execution_end" && e.toolCallId === id);
		assert.equal(endOf("call-bad")?.isError, true);
		assert.equal(endOf("call-good")?.isError, false);
		assert.equal(calls.length, 2, "the invalid call triggered a second model prompt");

		const saved = chatStore.getChat(chat.id)!;
		assert.ok(projectView(saved.messages)[1]!.parts.some((p) => p.type === "tool-quiz" && (p as { state?: string }).state === "output-error"));
		assert.equal(danglingQuestionOf(saved.messages)?.toolCallId, "call-good", "the RETRIED quiz is the pending one");
	});

	it("parallel quiz calls are asked, saved, and answered in the model's call order", async () => {
		const QUIZ_A = { ...QUIZ_INPUT, question: "Quiz A?" };
		const QUIZ_B = { ...QUIZ_INPUT, question: "Quiz B?" };
		const { engine } = scriptedTeacher([() => toolUse(fauxToolCall("quiz", QUIZ_A, { id: "call-a" }), fauxToolCall("quiz", QUIZ_B, { id: "call-b" }))]);
		const chat = createConfiguredChat("Test: parallel quizzes");
		const events = eventsOf(await drainTurn(post(chat.id, { type: "text", text: "quiz me twice" }), agentFactory(engine)));

		const endOf = (id: string) => events.findIndex((e) => e.type === "tool_execution_end" && e.toolCallId === id && e.isError === false);
		assert.ok(endOf("call-a") !== -1 && endOf("call-a") < endOf("call-b"), "sequential execution in call order");

		const saved = chatStore.getChat(chat.id)!;
		const quizIds = projectView(saved.messages)[1]!.parts.filter((p) => p.type === "tool-quiz").map((p) => (p as { toolCallId: string }).toolCallId);
		assert.deepEqual(quizIds, ["call-a", "call-b"]);
		assert.equal(danglingQuestionOf(saved.messages)?.toolCallId, "call-a");
		const answered = [...saved.messages, newAnswerResult("call-a", "quiz", gradedAnswer(QUIZ_A, ["Mercury"]))];
		assert.equal(danglingQuestionOf(answered)?.toolCallId, "call-b");
	});

	it("explain: the free-text answer snapshots the commitment and reaches the model", async () => {
		const EXPLAIN_INPUT = { question: "Explain why Mercury is hard to observe.", correctAnswer: "Its small angular separation from the Sun.", nodeId: "planet-order", type: "check" };
		const { engine, calls } = scriptedTeacher([
			() => toolUse(fauxToolCall("explain", EXPLAIN_INPUT, { id: "call-1" })),
			() => fauxAssistantMessage([fauxText("Right — it hugs the Sun.")]),
		]);
		const chat = createConfiguredChat("Test: explain mechanic");
		const tools = createTeacherTools({ chatId: chat.id, chatStore, jobStore, spawn: () => {} }, { explain: true });
		assert.ok(tools.explain && !tools.quiz, "explain armed, quiz dropped — one quizzing tool");
		const factory: Parameters<typeof handleChatRequest>[1] = (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages, tools });
		await drainTurn(post(chat.id, { type: "text", text: "teach me" }), factory);
		assert.deepEqual(danglingQuestionOf(chatStore.getChat(chat.id)!.messages)?.input, EXPLAIN_INPUT);

		const answer = buildAnswer(
			{ id: "call-1", kind: "explain", question: EXPLAIN_INPUT.question, mode: "text", options: [], committedAnswer: EXPLAIN_INPUT.correctAnswer, createdAt: new Date().toISOString() },
			{ text: "It stays near the Sun." },
		);
		assert.equal(answer.correct, undefined, "no client grading — the model grades");
		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer }), factory);

		const saved = chatStore.getChat(chat.id)!;
		const part = projectView(saved.messages)[1]!.parts.find((p) => p.type === "tool-explain") as { state?: string; output?: { committed?: string } };
		assert.equal(part.state, "output-available");
		assert.equal(part.output?.committed, EXPLAIN_INPUT.correctAnswer);
		assert.match(calls[1]!.join("\n"), /It stays near the Sun\./);
		assert.match(calls[1]!.join("\n"), /small angular separation/);
		assert.equal(danglingQuestionOf(saved.messages), null);
	});
});

describe("canonical persistence failures", () => {
	it("refuses a failed input save without building an agent or leaving a live turn", async () => {
		const { engine } = defaultLesson();
		const chat = createConfiguredChat("Test: failed answer write-ahead");
		await drainTurn(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine));
		const before = chatStore.getChat(chat.id)!.messages;
		const save = chatStore.saveMessages;
		let builds = 0;
		chatStore.saveMessages = () => { throw new Error("synthetic write-ahead failure"); };
		try {
			const res = await handleChatRequest(post(chat.id, { type: "answer", toolCallId: "call-1", answer: mercury() }), (opts) => {
				builds++;
				return agentFactory(engine)!(opts);
			});
			assert.equal(res.status, 500);
			const client = new SessionModel({ chatId: chat.id, initialMessages: before, fetch: async () => res.clone() });
			await client.submitAnswer("quiz", "call-1", mercury());
			assert.ok(client.getState().error, "the client surfaces the refusal");
			assert.equal(builds, 0);
			assert.equal(isTurnRunning(chat.id), false);
			assert.equal(runningTurn(chat.id), undefined);
			assert.deepEqual(chatStore.getChat(chat.id)!.messages, before);
		} finally { chatStore.saveMessages = save; }
	});

	it("reports a failed reply save before DONE while keeping the accepted answer durable", async () => {
		const { engine } = defaultLesson();
		const chat = createConfiguredChat("Test: failed reply persistence");
		await drainTurn(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine));
		const save = chatStore.saveMessages;
		let writes = 0;
		chatStore.saveMessages = (id, messages) => {
			if (++writes === 2) throw new Error("synthetic reply save failure");
			return save(id, messages);
		};
		try {
			const body = await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer: mercury() }), agentFactory(engine));
			const errors = eventsOf(body).filter((e) => e.type === "error");
			assert.equal(errors.length, 1);
			const errorText = errors[0]!.errorText as string;
			assert.ok(body.indexOf(errorText) < body.indexOf("[DONE]"));
			assert.equal(isTurnRunning(chat.id), false);
			assert.equal(chatStore.getChat(chat.id)!.messages.at(-1)?.role, "toolResult");
			// A submitter reaching GET /stream after the turn left the registry still sees the failure.
			const late = await streamRoute.GET(new Request("http://test/stream"), { params: Promise.resolve({ id: chat.id }) });
			assert.equal(eventsOf(await late.text()).find((e) => e.type === "error")?.errorText, errorText);
			// An idle view that missed the wire learns of it via the record and must not auto-continue.
			const snapshot = await (await recordRoute.GET(new Request("http://test/record"), { params: Promise.resolve({ id: chat.id }) })).json();
			assert.equal(needsContinuation(snapshot.messages), true, "the durable answer alone looks like an owed continuation");
			let automaticPosts = 0;
			const missedView = new SessionModel({ chatId: chat.id, initialMessages: [], fetch: async () => {
				automaticPosts++;
				return new Response("unexpected automatic retry", { status: 500 });
			} });
			missedView.setMessages(snapshot.messages, snapshot.turnFailure ?? undefined);
			await missedView.continueIfOwed(snapshot.messages);
			assert.equal(automaticPosts, 0, "the record notice blocks replacement");
			assert.equal(missedView.getState().error?.message, errorText);
		} finally { chatStore.saveMessages = save; }
	});

	it("does not redeliver a persisted learner steer after usage bookkeeping fails", async () => {
		const { engine } = scriptedTeacher([() => fauxAssistantMessage([fauxText("Synthetic response")])]);
		const chat = createConfiguredChat("Test: post-save bookkeeping failure");
		const steer = newUserMessage("Synthetic learner steer");
		const appendUsage = chatStore.appendTurnUsage;
		chatStore.appendTurnUsage = () => { throw new Error("synthetic usage write failure"); };
		try {
			const body = await drainTurn(post(chat.id, { type: "text", text: "go" }), (opts) => {
				const agent = createTeacherAgent(undefined, { engine, messages: opts.messages, onUsage: opts.onUsage });
				agent.subscribe((event) => {
					if (event.type === "agent_start") assert.equal(steerLiveChat(chat.id, steer), true);
				});
				return agent;
			});
			assert.ok(eventsOf(body).some((e) => e.type === "error"));
			assert.ok(chatStore.getChat(chat.id)!.messages.some((m) => m.id === steer.id), "the steer was saved before bookkeeping failed");
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

describe("turn liveness + write-ahead", () => {
	it("one turn per chat; the answer is durable BEFORE the turn finishes; the next turn is accepted after", async () => {
		const { engine } = defaultLesson();
		const chat = createConfiguredChat("Test: turn guard");
		await drainTurn(post(chat.id, { type: "text", text: "teach me" }), agentFactory(engine));

		assert.equal((await handleChatRequest(post(chat.id, { type: "answer", toolCallId: "call-1", answer: mercury() }), agentFactory(engine))).status, 200);
		assert.equal(isTurnRunning(chat.id), true);
		const midTurn = chatStore.getChat(chat.id)!.messages;
		assert.equal(midTurn.length, 3, "write-ahead appended the answer before finish");
		assert.equal(roleOf(midTurn[2]), "toolResult");
		assert.equal((await handleChatRequest(post(chat.id, { type: "text", text: "again" }), agentFactory(engine))).status, 409, "concurrent turn rejected");

		await drainRunning(chat.id);
		assert.equal(chatStore.getChat(chat.id)!.messages.length, 4);
		assert.equal(isTurnRunning(chat.id), false);
		const next = defaultLesson();
		assert.equal((await handleChatRequest(post(chat.id, { type: "text", text: "more" }), agentFactory(next.engine))).status, 200);
		await drainRunning(chat.id);
	});

	it("a pinned provider whose key is gone refuses with 503 provider_key_missing — nothing lingers", async () => {
		const chat = chatStore.createChat("Test: keyless provider"); createdChats.push(chat.id);
		const saved = process.env.TOGETHER_API_KEY;
		delete process.env.TOGETHER_API_KEY;
		try {
			chatStore.saveSettings(chat.id, { model: { provider: "together", id: "no-such-model" } });
			const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me" }), agentFactory(defaultLesson().engine));
			assert.equal(res.status, 503);
			const body = (await res.json()) as { code: string; provider: string; slots: string[] };
			assert.deepEqual({ code: body.code, provider: body.provider, slots: body.slots }, { code: "provider_key_missing", provider: "together", slots: ["strong"] });
			assert.equal(isTurnRunning(chat.id), false);
			assert.equal(chatStore.getChat(chat.id)!.messages.length, 0, "no write-ahead persist before the gate");
		} finally {
			if (saved !== undefined) process.env.TOGETHER_API_KEY = saved;
		}
	});
});

describe("background-turn runner (clients are views)", () => {
	it("subscribe mid-turn: a second view gets the FULL replay, then live; both close cleanly", async () => {
		const g = gate();
		const chat = createConfiguredChat("Test: reattach replay");
		assert.equal((await handleChatRequest(post(chat.id, { type: "text", text: "hold my turn" }), agentFactory(gatedTeacher(g.promise)))).status, 200);
		const handle = runningTurn(chat.id)!;
		const reader = new Response(handle.subscribe()).body!.getReader();
		await reader.read();
		const secondText = new Response(handle.subscribe()).text();

		g.release();
		const text = await secondText;
		assert.equal(eventsOf(text)[0]!.type, "agent_start", "replay starts from the very first event");
		assert.ok(text.includes("Gated reply."));
		assert.ok(text.endsWith("data: [DONE]\n\n"));
		const decoder = new TextDecoder();
		let firstTail = "";
		for (let r = await reader.read(); !r.done; r = await reader.read()) firstTail += decoder.decode(r.value, { stream: true });
		assert.ok(firstTail.endsWith("data: [DONE]\n\n"), "the first view is unaffected by the reattach");
	});

	it("chunk bursts coalesce to ONE message_update on the wire, carrying the latest full snapshot", async () => {
		// message_update is a full snapshot per chunk; retaining each one made
		// memory and replay quadratic in message length.
		const long = "quadratic blowup ".repeat(40);
		const chat = createConfiguredChat("Test: compaction law");
		const body = await drainTurn(post(chat.id, { type: "text", text: "go" }), agentFactory(engineOf([() => fauxAssistantMessage([fauxText(long)])])));
		const updates = eventsOf(body).filter((e) => e.type === "message_update");
		assert.equal(updates.length, 1);
		assert.ok(JSON.stringify(updates[0]!.message?.content ?? []).includes(long));
		assert.ok(JSON.stringify(chatStore.getChat(chat.id)!.messages).includes(long));
	});

	it("remote abort: any client can stop a running turn; the partial persists; subscribers close cleanly", async () => {
		const chat = createConfiguredChat("Test: remote abort");
		assert.equal((await handleChatRequest(post(chat.id, { type: "text", text: "wait forever" }), agentFactory(abortableTeacher()))).status, 200);
		const viewText = new Response(runningTurn(chat.id)!.subscribe()).text();

		assert.deepEqual(abortTurn(chat.id), { ok: true });
		assert.ok((await viewText).endsWith("data: [DONE]\n\n"));
		await waitFor(() => !isTurnRunning(chat.id), "aborted turn settle");
		assert.ok(chatStore.getChat(chat.id)!.messages.length >= 2, "the partial transcript persisted");
		assert.equal(runningTurn(chat.id), undefined);
		assert.deepEqual(abortTurn(chat.id), { ok: false, reason: "not_running" });
	});
});

describe("the silent dismissal (A2)", () => {
	it("writes the toolResult with NO wake — the next plain message carries it to the model", async () => {
		const { engine, calls } = defaultLesson();
		const chat = createConfiguredChat("Test: silent dismissal");
		await drainTurn(post(chat.id, { type: "text", text: "teach me" }), agentFactory(engine));

		assert.equal((await dismissPost(chat.id, "call-1")).status, 200);
		const saved = chatStore.getChat(chat.id)!;
		assert.equal(danglingQuestionOf(saved.messages), null);
		const tail = saved.messages.at(-1) as { role?: string; details?: { dismissed?: boolean } };
		assert.equal(tail.role, "toolResult");
		assert.equal(tail.details?.dismissed, true);
		assert.equal(calls.length, 1, "the dismissal woke nothing");
		assert.equal(isTurnRunning(chat.id), false);
		assert.equal(endsInDismissal(saved.messages), true);

		await drainTurn(post(chat.id, { type: "text", text: "tell me about Mars" }), agentFactory(engine));
		assert.equal(calls.length, 2);
		assert.match(calls[1]!.join("\n"), /dismissed/, "the dismissed result rode the wake's context");
		assert.equal(endsInDismissal(chatStore.getChat(chat.id)!.messages), false);
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
	const batchLesson = () =>
		scriptedTeacher([
			() => toolUse(fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" }), fauxToolCall("ask_user_question", ASK_INPUT, { id: "call-2" })),
			() => fauxAssistantMessage([fauxText("Both answered — good.")]),
		]);

	it("the sibling answer wakes NOTHING; the last answer fires the one turn with both results adjacent", async () => {
		const { engine, calls } = batchLesson();
		const chat = createConfiguredChat("Test: parallel questions");
		await drainTurn(post(chat.id, { type: "text", text: "two questions" }), agentFactory(engine));
		assert.equal(danglingQuestionOf(chatStore.getChat(chat.id)!.messages)?.toolCallId, "call-1");

		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer: mercury() }), agentFactory(engine));
		assert.equal(calls.length, 1, "the sibling answer woke NOTHING");
		let saved = chatStore.getChat(chat.id)!;
		assert.equal((saved.messages[2] as { toolCallId?: string }).toolCallId, "call-1");
		assert.equal(danglingQuestionOf(saved.messages)?.toolCallId, "call-2");

		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-2", answer: askAnswer(ASK_INPUT.question, "History") }), agentFactory(engine));
		assert.equal(calls.length, 2, "exactly one wake: the last answer's turn");
		saved = chatStore.getChat(chat.id)!;
		assert.equal(danglingQuestionOf(saved.messages), null);
		assert.match(calls[1]!.join("\n"), /Mercury[\s\S]*History/);
		assert.deepEqual(saved.messages.map(roleOf).slice(1, 5), ["assistant", "toolResult", "toolResult", "assistant"]);
	});

	it("answer then dismiss: NO wake (ending on a dismissal pauses); dismiss then answer: one wake carrying both", async () => {
		const first = batchLesson();
		const a = createConfiguredChat("Test: round 1");
		await drainTurn(post(a.id, { type: "text", text: "two questions" }), agentFactory(first.engine));
		await drainTurn(post(a.id, { type: "answer", toolCallId: "call-1", answer: mercury() }), agentFactory(first.engine));
		assert.equal((await dismissPost(a.id, "call-2", "ask")).status, 200);
		const savedA = chatStore.getChat(a.id)!.messages;
		assert.equal(danglingQuestionOf(savedA), null);
		assert.equal(needsContinuation(savedA), false);
		assert.equal(endsInDismissal(savedA), true);
		assert.equal(first.calls.length, 1);

		const second = batchLesson();
		const b = createConfiguredChat("Test: round 2");
		await drainTurn(post(b.id, { type: "text", text: "two questions" }), agentFactory(second.engine));
		assert.equal((await dismissPost(b.id, "call-1")).status, 200);
		assert.equal(second.calls.length, 1);
		assert.equal(danglingQuestionOf(chatStore.getChat(b.id)!.messages)?.toolCallId, "call-2");
		await drainTurn(post(b.id, { type: "answer", toolCallId: "call-2", answer: askAnswer("Next topic?", "Chemistry") }), agentFactory(second.engine));
		assert.equal(second.calls.length, 2);
		assert.match(second.calls[1]!.join("\n"), /Chemistry/);
		assert.match(second.calls[1]!.join("\n"), /dismissed/);
	});
});

describe("composer steering: POST /api/chats/[id]/steer", () => {
	const steerPost = (chatId: string, input: unknown) => routePost(steerRoute, chatId, { input });

	it("honest rejections: 404 unknown chat, 400 bad input, 409 when no turn is live", async () => {
		const chat = createConfiguredChat("Test: steer rejections");
		const cases: Array<[string, unknown, number]> = [
			["chat_nope", { type: "steer", id: "steer_1", text: "hi" }, 404],
			[chat.id, { type: "steer", id: "", text: "hi" }, 400],
			[chat.id, { type: "text", text: "hi" }, 400],
			[chat.id, { type: "steer", id: "steer_1", text: "  " }, 400],
			[chat.id, { type: "steer", id: "steer_1", text: "hi" }, 409],
		];
		for (const [id, input, status] of cases) assert.equal((await steerPost(id, input)).status, status, JSON.stringify(input));
	});

	it("200 when a turn runs; the drain lands the card in the same run and the model sees it", async () => {
		const calls: string[][] = [];
		const g = gate();
		const engine = engineOf([
			async (context) => {
				calls.push(promptOf(context));
				await g.promise;
				return fauxAssistantMessage([fauxText("Teaching the solar system…")]);
			},
			recorded(calls, () => fauxAssistantMessage([fauxText("Steered — covering Venus too.")])),
		]);
		const chat = createConfiguredChat("Test: steer live");
		await handleChatRequest(post(chat.id, { type: "text", text: "teach me" }), agentFactory(engine));
		await waitFor(() => calls.length === 1, "first model call started");

		assert.equal((await steerPost(chat.id, { type: "steer", id: "steer_live1", text: "also cover Venus" })).status, 200);
		const viewText = drainRunning(chat.id);
		g.release();
		assert.match(await viewText, /also cover Venus/);
		assert.equal(calls.length, 2, "still one run — the steer continued it");
		assert.match(calls[1]!.join("\n"), /also cover Venus/);

		const saved = chatStore.getChat(chat.id)!;
		assert.deepEqual(saved.messages.map(roleOf), ["user", "assistant", "user", "assistant"]);
		assert.equal(idOf(saved.messages[2]), "steer_live1", "the client-minted id survived to the record");
	});
});

// Providers that reset tool-call ids per response (`call_0` every turn) once
// corrupted the fold and answer routing; the wire boundary now remints collisions.
describe("duplicate provider tool-call ids", () => {
	it("every `call_0` turn keeps its identity: ask answered as ask, quiz as quiz, ids unique in the record", async () => {
		const ASK = { question: "What do you want from Lacan?" };
		const { engine } = scriptedTeacher([
			() => toolUse(fauxToolCall("ask_user_question", ASK, { id: "call_0" })),
			() => toolUse(fauxToolCall("quiz", QUIZ_INPUT, { id: "call_0" })),
			() => fauxAssistantMessage([fauxText("Right.")]),
		]);
		const chat = createConfiguredChat("Lacan: duplicate call_0 turns");
		await drainTurn(post(chat.id, { type: "text", text: "teach me Lacan" }), agentFactory(engine));
		const askPending = danglingQuestionOf(chatStore.getChat(chat.id)!.messages)!;
		assert.equal(askPending.tool, "ask_user_question");
		const askId = askPending.toolCallId;
		await drainTurn(post(chat.id, { type: "answer", toolCallId: askId, answer: askAnswer(ASK.question, "The theory core") }), agentFactory(engine));

		const quizPending = danglingQuestionOf(chatStore.getChat(chat.id)!.messages)!;
		assert.equal(quizPending.tool, "quiz");
		const quizId = quizPending.toolCallId;
		assert.notEqual(quizId, askId, "the colliding id was reminted");
		await drainTurn(post(chat.id, { type: "answer", toolCallId: quizId, answer: mercury() }), agentFactory(engine));

		const saved = chatStore.getChat(chat.id)!;
		const callIds = saved.messages.flatMap((m) => (m.role === "assistant" ? (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => c.id) : []));
		assert.equal(new Set(callIds).size, 2);
		const parts = projectView(saved.messages).flatMap((v) => v.parts) as Array<{ toolCallId?: string; state?: string; output?: { kind?: string } }>;
		const outcome = (id: string) => parts.find((p) => p.toolCallId === id);
		assert.deepEqual([outcome(askId)?.state, outcome(askId)?.output?.kind], ["output-available", "ask"]);
		assert.deepEqual([outcome(quizId)?.state, outcome(quizId)?.output?.kind], ["output-available", "quiz"]);
	});
});
