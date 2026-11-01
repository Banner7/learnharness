/**
 * Job infrastructure — deterministic, zero network: the job store, steer
 * helpers, dispatch, the research/pdf runners, the wake pipeline, abort,
 * crash recovery, and composer steering.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
	accumulateJobUsage,
	buildAbortSteer,
	buildProbeHandoffSteer,
	buildSubagentSteer,
	isSubagentFailure,
	steerDelivered,
	type DemoResult,
	type JobUsage,
	type PdfResult,
	type ResearchResult,
	type SteerMessage,
	type VisualResult,
} from "../src/core/contracts.ts";
import { composeInstructions, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import {
	abortJob,
	deliverJobResult,
	noteSteersDurable,
	discardChatDeliveries,
	reconcileUserSteers,
	recoverStaleJobs,
	registerLiveAgent,
	setJobRespawn,
	setTurnRunner as setRawTurnRunner,
	type TurnRunner,
	settleSteers,
	steerLiveChat,
	unregisterLiveAgent,
} from "../src/server/jobs.ts";
import { registerJobAbort, unregisterJobAbort } from "../src/agent/subagents/aborts.ts";
import { beginTurn, endTurn } from "../src/server/turn-liveness.ts";
import { persistTurn } from "../src/server/turn-service.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { createJobRunner, pdfModelOverride, researchModelOverride } from "../src/agent/subagents/runner.ts";
import { providerKeyMissing, type ModelSlotName } from "../src/core/settings.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { SearchProvider } from "../src/core/search.ts";
import { PATHS } from "../config.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import { subscribe } from "../src/core/events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { SteerInput } from "../src/core/input-events.ts";

// Scripted turns pin openrouter; the key-presence gate needs a key.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const createdChats: string[] = [];
const createdJobs: string[] = [];

const userMsg = (id: string, content: string, timestamp = 1) => ({ id, role: "user", content, timestamp }) as never as LhMessage;

function assistantMsg(id: string, content: unknown[], stopReason = "toolUse"): LhMessage {
	return {
		id, role: "assistant", content, api: "openai-completions", provider: "openrouter", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason, timestamp: 1,
	} as never;
}

function toolResult(toolCallId: string, toolName: string, text: string, details: unknown = text, isError = false, id = "r1"): LhMessage {
	return { id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], details, isError, timestamp: 1 } as never;
}

const quizCall = (id = "a1") => assistantMsg(id, [{ type: "toolCall", id: "quiz-call", name: "quiz", arguments: { question: "q", choices: ["a", "b"] } }]);

/** User text + an assistant tool call + its dispatch ack. */
function nativeToolMessages(text: string, tool: string, toolCallId: string, input: unknown): LhMessage[] {
	return [
		userMsg("u1", text),
		assistantMsg("a1", [{ type: "toolCall", id: toolCallId, name: tool, arguments: input as never }]),
		toolResult(toolCallId, tool, "Dispatched."),
	];
}

function newChat(label: string, messages: LhMessage[] = []): string {
	const chat = chatStore.createChat(`Test: ${label}`);
	createdChats.push(chat.id);
	if (messages.length) chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

function newJob(chatId: string, kind: "research" | "demo" | "pdf", toolCallId: string) {
	const job = jobStore.createJob({ kind, chatId, toolCallId });
	createdJobs.push(job.id);
	return job;
}

function researchJob(label: string, toolCallId: string): { chatId: string; jobId: string } {
	const chatId = newChat(label, nativeToolMessages("hi", "research", toolCallId, RESEARCH_INPUT));
	return { chatId, jobId: newJob(chatId, "research", toolCallId).id };
}

async function withModel<T>(slot: { current?: PiEngine }, engine: PiEngine, run: () => Promise<T>): Promise<T> {
	slot.current = engine;
	try {
		return await run();
	} finally {
		slot.current = undefined;
	}
}

/* Hermeticity fence (owner round 7, 2026-10-05): the jobs seams are
 * module-global and the sweep scans every job, so every test starts identical. */
afterEach(() => {
	for (const id of createdJobs) {
		const job = jobStore.getJob(id);
		if (job?.status === "running") jobStore.updateJob(id, { status: "done", activity: "settled (fence)" });
		if (job?.delivery?.status === "pending") jobStore.updateJob(id, { delivery: { ...job.delivery, status: "delivered" } });
		unregisterJobAbort(id);
	}
	for (const chatId of createdChats) discardChatDeliveries(chatId);
	// Late wakes from a prior test must be inert.
	setJobRespawn(() => {});
	setTurnRunner(async () => 200);
});

after(() => {
	for (const id of createdChats) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
	for (const id of createdJobs) fs.rmSync(path.join(PATHS.data, "jobs", `${id}.json`), { force: true });
	researchModelOverride.current = undefined;
});

/** A scripted pi engine; every test string streams as one delta. */
function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A model call that never resolves until its abort signal fires. */
function abortableFactory(): FauxResponseStep {
	const factory = (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
		new Promise<AssistantMessage>((resolve) => {
			const sig = options?.signal;
			if (sig?.aborted) return resolve(fauxAssistantMessage("late"));
			sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
		});
	return factory as unknown as FauxResponseStep;
}

/** The POST acks and closes; drain the turn through the reattach stream. */
async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<string> {
	const { chatId } = (await req.clone().json()) as { chatId: string };
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	const handle = runningTurn(chatId);
	return handle ? new Response(handle.subscribe()).text() : "";
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

function waitFor(cond: () => boolean, timeoutMs = 30_000, what = "condition"): Promise<void> {
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("job store", () => {
	it("create → get → update → list round-trips, scoped to the chat", () => {
		const job = newJob("chat_storetest", "research", "call-store");
		assert.match(job.id, /^job_/);
		assert.equal(job.status, "running");

		const updated = jobStore.updateJob(job.id, { activity: "x", status: "done", result: { brief: "b" } })!;
		assert.equal(updated.status, "done");
		assert.ok(updated.updatedAt >= job.updatedAt);
		assert.equal(jobStore.getJob(updated.id)!.toolCallId, "call-store", "identity fields survive a patch");

		assert.ok(jobStore.listJobs("chat_storetest").some((j) => j.id === job.id));
		assert.equal(jobStore.listJobs("chat_other").some((j) => j.id === job.id), false);
		assert.equal(jobStore.findJobByToolCallId("chat_storetest", "call-store")?.id, job.id);
		assert.equal(jobStore.findJobByToolCallId("chat_storetest", "call-missing"), null);
	});

	it("every real write emits jobs-changed {chatId}; reads and no-op writes are silent", () => {
		const got: (string | undefined)[] = [];
		const off = subscribe((e) => {
			if (e.type === "jobs-changed") got.push(e.chatId);
		});
		const expect = (want: string[]) => {
			assert.deepEqual(got, want);
			got.length = 0;
		};
		const job = newJob("chat_storeemit", "research", "call-emit");
		expect(["chat_storeemit"]);
		jobStore.updateJob(job.id, { activity: "still working" });
		expect(["chat_storeemit"]);
		jobStore.updateJob("job_missing", { activity: "noop" });
		jobStore.listJobs("chat_storeemit");
		jobStore.getJob(job.id);
		expect([]);
		jobStore.deleteJobsForChat("chat_storeemit");
		expect(["chat_storeemit"]);
		jobStore.deleteJobsForChat("chat_storeemit");
		expect([]);
		off();
	});
});

describe("steer helpers (contracts.ts)", () => {
	const research: ResearchResult = { brief: "BRIEF", sources: [{ title: "s", url: "https://x.test" }] };
	const demo: DemoResult = { title: "T", html: "<html></html>", tested: true, notes: "ok" };
	const visual: VisualResult = { svg: "<svg/>", notes: "ok" };

	it("result and abort steers share the deterministic per-job id; payload rides details", () => {
		const steer = buildSubagentSteer({ id: "job_x", kind: "research", toolCallId: "call-x" }, research);
		assert.equal(steer.id, "steer_job_x");
		assert.ok(steer.content.includes("BRIEF"));
		assert.deepEqual(steer.details, { jobId: "job_x", kind: "research", toolCallId: "call-x", result: research });

		const abort = buildAbortSteer({ id: "job_c", kind: "demo", toolCallId: "call-c" });
		assert.equal(abort.id, "steer_job_c");
		assert.equal(abort.customType, "subagent-abort");
		assert.deepEqual(abort.details, { jobId: "job_c", kind: "demo", toolCallId: "call-c", aborted: true });
	});

	it("accumulateJobUsage sums per call; never-reported fields stay undefined; lastStep mirrors the latest call", () => {
		const u = (inputTokens: number, outputTokens: number, cacheReadTokens?: number) => ({
			inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: undefined, cacheWrite1hTokens: undefined, reasoningTokens: undefined,
		});
		let total: JobUsage | undefined = accumulateJobUsage(undefined, "m", { inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 4 } });
		assert.deepEqual(total, { model: "m", ...u(10, 5, 4), calls: [u(10, 5, 4)], steps: 1, lastStep: u(10, 5, 4) });
		total = accumulateJobUsage(total, "m", { inputTokens: 20, outputTokens: 0 });
		assert.equal(total.inputTokens, 30);
		assert.equal(total.outputTokens, 5);
		assert.equal(total.cacheReadTokens, 4, "unreported after reported contributes 0");
		assert.equal(total.cacheWriteTokens, undefined, "never reported stays absent, never zero");
		assert.equal(total.steps, 2);
		assert.equal(total.calls?.length, 2);
		assert.deepEqual(total.lastStep, u(20, 0));
	});

	it("isSubagentFailure recognizes only failure shapes", () => {
		const pdf: PdfResult = { path: "/tmp/doc.pdf", question: "q?", brief: "On p. 2.", pagesRead: [2], pagesConsulted: [1, 2] };
		const cases: [Parameters<typeof isSubagentFailure>[0], unknown, boolean][] = [
			["research", research, false],
			["research", { brief: "Research failed: x", sources: [] }, true],
			["research", { brief: "Research failed: x", sources: [{ title: "s", url: "https://x" }] }, false],
			["demo", demo, false],
			["demo", { ...demo, html: "" }, true],
			["visual", visual, false],
			["visual", { ...visual, svg: "" }, true],
			["pdf", pdf, false],
			["pdf", { ...pdf, brief: "PDF failed: unreadable" }, true],
		];
		for (const [kind, result, want] of cases) assert.equal(isSubagentFailure(kind, result as never), want, `${kind} ${JSON.stringify(result)}`);
	});

	it("steerDelivered matches on the steer id, probe handoffs included", () => {
		const steer = buildSubagentSteer({ id: "job_y", kind: "demo", toolCallId: "c" }, demo);
		const handoff = buildProbeHandoffSteer("chat_q");
		assert.equal(handoff.id, "steer_probe_chat_q");
		assert.equal(steerDelivered([], steer.id), false);
		assert.equal(steerDelivered([steer], steer.id), true);
		assert.equal(steerDelivered([steer], handoff.id), false);
		assert.equal(steerDelivered([handoff], handoff.id), true);
	});
});

/** Capture the steer and persist it, like the pipeline's accepted wake. */
function fakeDeliver() {
	const steers: SteerMessage[] = [];
	return {
		steers,
		deliver: async (steer: SteerMessage) => {
			steers.push(steer);
			const job = jobStore.getJob((steer.details as { jobId: string }).jobId)!;
			chatStore.saveMessages(job.chatId, [...chatStore.getChat(job.chatId)!.messages, steer]);
			noteSteersDurable(job.chatId, [steer]);
		},
	};
}

/** Fake wakes model canonical input acceptance, not just HTTP acknowledgement. */
function setTurnRunner(run: TurnRunner): void {
	setRawTurnRunner(async (chatId, input) => {
		const status = await run(chatId, input);
		if (status === 200 && input.type === "steers") {
			const record = chatStore.getChat(chatId);
			if (record) chatStore.saveMessages(chatId, [...record.messages, ...input.steers.filter((s) => !steerDelivered(record.messages, s.id))]);
		}
		return status;
	});
}

/** Record each wake's steers; `status` picks the runner's reply per call. */
function captureWakes(status: (call: number) => number = () => 200): SteerMessage[][] {
	const fired: SteerMessage[][] = [];
	setTurnRunner(async (_cid, input) => {
		fired.push((input as SteerInput).steers as SteerMessage[]);
		return status(fired.length);
	});
	return fired;
}

const RESEARCH_INPUT = {
	question: "What is the latest stable sigma.js version?",
	context: "Choosing a graph rendering library for the lesson.",
};

const BRIEF = `## Summary
sigma.js v3 is current.

## Findings
1. **v3 is the latest major.** [sigma.js docs](https://www.sigmajs.org/docs)

## Sources
- sigma.js docs (https://www.sigmajs.org/docs)`;

/** Turn 1: a web_search call; turn 2: the brief. */
function researcherModel(): PiEngine {
	return fauxEngine([
		fauxAssistantMessage([fauxToolCall("web_search", { query: "sigma.js latest version" }, { id: "ws1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText(BRIEF)]),
	]);
}

/** A recording search port: no network, queries captured. */
function stubSearch(): SearchProvider & { queries: string[] } {
	const queries: string[] = [];
	return {
		id: "tavily",
		async search(query: string, count: number) {
			queries.push(`${query} (${count})`);
			return [{ title: "sigma.js", url: "https://www.sigmajs.org/", snippet: "v3 released" }];
		},
		queries,
	};
}

describe("dispatch and the research runner", () => {
	it("the research call acks mid-turn; the turn continues and the runner steers exactly once", async () => {
		const chatId = newChat("research dispatch");
		chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const delivery = fakeDeliver();
		const testRunner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver, searchProvider: () => stubSearch() });
		const engine = fauxEngine([
			fauxAssistantMessage([fauxText("Let me check."), fauxToolCall("research", RESEARCH_INPUT, { id: "call-r1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Back with the brief.")]),
		]);
		const tools = createTeacherTools({ chatId, chatStore, jobStore, spawn: (job, input) => void testRunner.runJob(job.id, input) });

		await withModel(researchModelOverride, researcherModel(), async () => {
			const body = await drainTurn(
				post(chatId, { type: "text", text: "teach me graph rendering" }),
				(opts) => createTeacherAgent(undefined, { engine, tools, messages: opts.messages }),
			);
			assert.ok(body.includes("Back with the brief."), "the turn continued after the dispatch");

			const part = projectNative(chatStore.getChat(chatId)!.messages)[1]!.parts.find((p) => p.type === "tool-research");
			assert.equal(part?.type === "tool-research" && part.state, "output-available", "resolved at dispatch, not held pending");

			const job = jobStore.findJobByToolCallId(chatId, "call-r1")!;
			createdJobs.push(job.id);
			await waitFor(() => jobStore.getJob(job.id)!.status !== "running", 8000, "research job completion");
			assert.equal(jobStore.getJob(job.id)!.status, "done");
			assert.equal(delivery.steers.length, 1);
			assert.equal((delivery.steers[0]!.details as { jobId: string }).jobId, job.id);
		});
	});

	it("runJob recovers its input from the transcript: result + sources on the job, search on the injected port", async () => {
		const { jobId } = researchJob("runner completion", "call-run1");
		const search = stubSearch();
		const runner = createJobRunner({ chatStore, jobStore, deliver: fakeDeliver().deliver, searchProvider: () => search });
		await withModel(researchModelOverride, researcherModel(), () => runner.runJob(jobId));

		const done = jobStore.getJob(jobId)!;
		assert.equal(done.status, "done");
		const result = done.result as ResearchResult;
		assert.equal(result.brief, BRIEF);
		assert.equal(result.sources[0]!.url, "https://www.sigmajs.org/docs");
		assert.deepEqual(search.queries, ["sigma.js latest version (5)"]);
	});

	it("a failing runner still steers the failure brief and the job lands error", async () => {
		const { jobId } = researchJob("runner failure", "call-err1");
		const delivery = fakeDeliver();
		const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver });
		await withModel(researchModelOverride, fauxEngine([() => { throw new Error("model exploded"); }]), () => runner.runJob(jobId));

		const errored = jobStore.getJob(jobId)!;
		assert.equal(errored.status, "error");
		assert.match(errored.error ?? "", /model exploded/);
		assert.ok(delivery.steers[0]!.content.includes("Research failed: model exploded"));
		assert.deepEqual((delivery.steers[0]!.details as { result: ResearchResult }).result.sources, []);
	});

	it("refuses honestly — error + failure steer, no phantom run — when no engine or no provider key", async () => {
		const keylessEngine = fauxEngine([]);
		const cases = [
			{ name: "no engine", deps: {}, error: [/No model configured/, /missing: cheap/], steerHas: "Research failed: No model configured" },
			{
				name: "no key",
				deps: { engineFor: () => keylessEngine, providerKeyMissing: (provider: string, tier: ModelSlotName) => providerKeyMissing(provider, [tier]) },
				error: providerKeyMissing(keylessEngine.model.provider, ["cheap"]).error!,
				steerHas: `Research failed: ${providerKeyMissing(keylessEngine.model.provider, ["cheap"]).error}`,
			},
		];
		for (const [i, c] of cases.entries()) {
			const { jobId } = researchJob(`refusal ${c.name}`, `call-refuse-${i}`);
			const delivery = fakeDeliver();
			await createJobRunner({ chatStore, jobStore, deliver: delivery.deliver, ...c.deps }).runJob(jobId);
			const done = jobStore.getJob(jobId)!;
			assert.equal(done.status, "error", c.name);
			if (typeof c.error === "string") assert.equal(done.error, c.error);
			else for (const re of c.error) assert.match(done.error ?? "", re);
			assert.equal(delivery.steers.length, 1, `${c.name}: the teacher is not stranded`);
			assert.ok(delivery.steers[0]!.content.includes(c.steerHas), c.name);
			assert.equal((done.result as ResearchResult).sources.length, 0);
		}
	});
});

describe("pdf runner", () => {
	const PDF_FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
	const PDF_INPUT = { path: PDF_FIXTURE, question: "What is the integral of x dx?" };
	const relativePath = path.join("Course notes", "sample document.pdf");
	let home: string;
	const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

	before(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-job-home-"));
		fs.mkdirSync(path.dirname(path.join(home, relativePath)), { recursive: true });
		fs.copyFileSync(PDF_FIXTURE, path.join(home, relativePath));
		process.env.HOME = process.env.USERPROFILE = home;
	});

	after(() => {
		for (const [key, value] of Object.entries(original)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(home, { recursive: true, force: true });
	});

	/** Triage, extract pages 1-2, then brief. */
	const pdfReaderModel = () => fauxEngine([
		fauxAssistantMessage([fauxToolCall("pdf_info", {}, { id: "i1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1-2" }, { id: "e1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("The integral rule appears on page 1 (p. 1): x dx integrates to x^2/2.")]),
	]);

	for (const mode of ["dispatch", "recovery"] as const) {
		it(`resolves a home-relative PDF from ${mode} input without rewriting history`, async () => {
			const toolCallId = `call-pdf-relative-${mode}`;
			const input = { ...PDF_INPUT, path: relativePath };
			const messages = nativeToolMessages("read this pdf", "pdf", toolCallId, input);
			const before = structuredClone(messages);
			const chatId = newChat(`relative PDF ${mode}`, messages);
			const job = newJob(chatId, "pdf", toolCallId);
			const delivery = fakeDeliver();
			const runner = createJobRunner({ chatStore, jobStore, deliver: delivery.deliver });
			await withModel(pdfModelOverride, pdfReaderModel(), () => runner.runJob(job.id, mode === "dispatch" ? input : undefined));

			// Worker completion is not the delivery barrier.
			await waitFor(() => jobStore.getJob(job.id)?.delivery?.status === "delivered", 8000, "canonical PDF delivery");
			const done = jobStore.getJob(job.id)!;
			assert.equal(done.status, "done");
			const result = done.result as PdfResult;
			assert.equal(result.path, path.join(home, relativePath));
			assert.match(result.brief, /integral rule/);
			assert.deepEqual(result.pagesRead, [1, 2]);
			assert.deepEqual(result.pagesConsulted, [1, 2]);
			assert.equal(input.path, relativePath, "dispatch input remains relative");
			const persisted = chatStore.getChat(chatId)!.messages;
			assert.deepEqual(persisted.slice(0, before.length), before, "history and tool-call arguments unchanged");
			assert.deepEqual((delivery.steers[0]!.details as { result: PdfResult }).result, result);
			assert.deepEqual(persisted.slice(before.length), [delivery.steers[0]], "exactly one result appended");
		});
	}

	it("an unreadable source lands error with a PDF failed: brief", async () => {
		const job = newJob(newChat("pdf runner failure"), "pdf", "call-pdf2");
		const runner = createJobRunner({ chatStore, jobStore, deliver: fakeDeliver().deliver });
		const badPath = path.join(import.meta.dirname, "fixtures", "not-a-pdf.txt");
		await withModel(pdfModelOverride, pdfReaderModel(), () => runner.runJob(job.id, { path: badPath, question: "anything" }));

		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "error");
		const result = done.result as PdfResult;
		assert.match(result.brief, /^PDF failed:/);
		assert.deepEqual(result.pagesRead, []);
		assert.deepEqual(result.pagesConsulted, []);
	});
});

/**
 * Pipeline tests drive deliverJobResult with an injected fake turn runner.
 * The pump polls at 400ms with a 1.5s grace after the gates open.
 */
describe("wake pipeline (src/server/jobs.ts)", () => {
	/** A chat with a finished job whose result awaits delivery. */
	function setup(): { chatId: string; jobId: string; steer: SteerMessage } {
		const chatId = newChat("wake pipeline", [userMsg("u1", "hello")]);
		const job = newJob(chatId, "research", `call-${jobStore.listJobs(chatId).length}`);
		const result: ResearchResult = { brief: "Done: it works.", sources: [{ title: "s", url: "https://x.test" }] };
		jobStore.updateJob(job.id, { result, status: "done", activity: "finished", delivery: { kind: "result", status: "pending" } });
		return { chatId, jobId: job.id, steer: buildSubagentSteer(job, result) };
	}

	const deliveryStatus = (jobId: string) => jobStore.getJob(jobId)!.delivery?.status;

	/** A minimal stand-in for pi's Agent — the pump touches only steer(). */
	function fakeAgent(): { handed: SteerMessage[]; agent: never } {
		const handed: SteerMessage[] = [];
		return { handed, agent: { steer: (m: SteerMessage) => handed.push(m) } as never };
	}

	/** Settle a live run that persisted `persisted`. */
	function settleRun(chatId: string, persisted: SteerMessage[]): void {
		unregisterLiveAgent(chatId);
		settleSteers(chatId, persisted as never);
		endTurn(chatId);
	}

	it("delivers: fires the turn runner with the steer, then marks delivery done", async () => {
		const { chatId, jobId, steer } = setup();
		const fired = captureWakes();
		await deliverJobResult(steer);
		assert.equal(deliveryStatus(jobId), "delivered");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
		assert.deepEqual(fired.map((s) => s.map((m) => m.id)), [[steer.id]]);
		assert.ok(steerDelivered(chatStore.getChat(chatId)!.messages, steer.id), "the wake ran on the job's chat");
	});

	it("waits while a question is pending, and fires once it is answered", async () => {
		const { chatId, jobId, steer } = setup();
		const fired = captureWakes();
		chatStore.saveMessages(chatId, [userMsg("u1", "hello"), quizCall()]);

		// Floats while the quiz blocks — awaiting it now would deadlock.
		const delivery = deliverJobResult(steer);
		await delay(1200);
		assert.equal(fired.length, 0, "no wake while the quiz is pending");
		assert.equal(deliveryStatus(jobId), "pending");

		const answered = toolResult("quiz-call", "quiz", "answered", { answer: "a", correct: true, explanation: "" });
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, answered]);
		await delivery;
		assert.equal(fired.length, 1);
	});

	for (const pause of ["dismissal", "question recovery"] as const) it(`the ${pause} pause holds deliveries until the user's next turn settles`, async () => {
		const { chatId, jobId, steer } = setup();
		const fired = captureWakes();
		// Both resolutions clear the dangling call; only the persisted
		// manual-only pause holds the wake.
		const resolution = pause === "dismissal"
			? toolResult("quiz-call", "quiz", "skipped", { kind: "quiz", questionText: "q", dontKnow: false, answers: [], dismissed: true, answeredAt: "t" })
			: toolResult("quiz-call", "quiz", "Replacement requested", { questionRecovery: true }, true);
		chatStore.saveMessages(chatId, [userMsg("u1", "hello"), quizCall(), resolution]);

		const delivery = deliverJobResult(steer);
		await delay(1200);
		assert.equal(fired.length, 0, `no wake while ${pause}-paused`);
		assert.equal(deliveryStatus(jobId), "pending", "queued, not lost");

		const afterUser = [...chatStore.getChat(chatId)!.messages, userMsg("u2", "moving on", 2)];
		chatStore.saveMessages(chatId, afterUser);
		settleSteers(chatId, afterUser);
		await delivery;
		assert.equal(fired.length, 1);
	});

	it("retries a 409 (a client turn raced in) and delivers on the retry", async () => {
		const { jobId, steer } = setup();
		const fired = captureWakes((call) => (call === 1 ? 409 : 200));
		await deliverJobResult(steer);
		assert.ok(fired.length >= 2);
		assert.equal(deliveryStatus(jobId), "delivered");
	});

	it("a failed start stays pending, never retries automatically, and rides the next live run", async () => {
		const { chatId, jobId, steer } = setup();
		const fired = captureWakes(() => 500);
		const delivery = deliverJobResult(steer);
		await waitFor(() => fired.length === 1, 8000, "failed start attempted");
		await delay(1000);
		assert.equal(fired.length, 1, "no automatic retry loop");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
		assert.equal(jobStore.getJob(jobId)!.error, undefined);
		assert.equal(deliveryStatus(jobId), "pending");
		const { handed, agent } = fakeAgent();
		assert.ok(beginTurn(chatId));
		registerLiveAgent(chatId, agent);
		assert.deepEqual(handed.map((m) => m.id), [steer.id]);
		settleRun(chatId, [steer]);
		await delivery;
	});

	it("is idempotent: a steer already in the transcript is acknowledged without a wake", async () => {
		const { chatId, jobId, steer } = setup();
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, steer]);
		const fired = captureWakes();
		await deliverJobResult(steer);
		assert.equal(fired.length, 0);
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("only a durable marker acknowledges delivery, idempotently", () => {
		const { chatId, jobId, steer } = setup();
		assert.equal(deliveryStatus(jobId), "pending");
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, steer]);
		noteSteersDurable(chatId, [steer]);
		noteSteersDurable(chatId, [steer]);
		assert.equal(deliveryStatus(jobId), "delivered");
		assert.equal(jobStore.getJob(jobId)!.activity, "finished");
	});

	it("the idle wake carries every pending marker in one turn", async () => {
		const { chatId, steer } = setup();
		const job2 = newJob(chatId, "research", "call-2");
		const result: ResearchResult = { brief: "Second result.", sources: [] };
		jobStore.updateJob(job2.id, { result });
		const steer2 = buildSubagentSteer(job2, result);
		const fired = captureWakes();
		await Promise.all([deliverJobResult(steer), deliverJobResult(steer2)]);
		assert.equal(fired.length, 1);
		assert.deepEqual(fired[0]!.map((s) => s.id).sort(), [steer.id, steer2.id].sort());
	});

	describe("live steering handoff + settlement reconciliation", () => {
		it("hands queued markers to the live run; delivery resolves at settlement with no wake", async () => {
			const { chatId, jobId, steer } = setup();
			const { handed, agent } = fakeAgent();
			const fired = captureWakes();
			assert.ok(beginTurn(chatId));
			registerLiveAgent(chatId, agent);

			const delivery = deliverJobResult(steer);
			await waitFor(() => handed.length === 1, 8000, "marker handed to the live agent");
			await delay(1200);
			assert.equal(fired.length, 0, "no wake while the run is live");
			assert.equal(deliveryStatus(jobId), "pending");

			settleRun(chatId, [steer]);
			await delivery;
			assert.equal(fired.length, 0);
		});

		it("a handed marker the run never persisted strands at settlement; the idle wake delivers it", async () => {
			const { chatId, steer } = setup();
			const { handed, agent } = fakeAgent();
			const fired = captureWakes();
			assert.ok(beginTurn(chatId));
			registerLiveAgent(chatId, agent);
			const delivery = deliverJobResult(steer);
			await waitFor(() => handed.length === 1, 8000, "handed");
			settleRun(chatId, []);
			await delivery;
			assert.equal(fired.length, 1);
		});

		it("a probe handoff never rides a live run — it waits the turn out and wakes", async () => {
			const chatId = newChat("handoff never live", nativeToolMessages("teach me calc", "probe_done", "call-pd", { ok: true }));
			const handoff = buildProbeHandoffSteer(chatId);
			const { handed, agent } = fakeAgent();
			const fired = captureWakes();
			assert.ok(beginTurn(chatId));
			registerLiveAgent(chatId, agent);

			const delivery = deliverJobResult(handoff);
			await delay(1200);
			assert.equal(handed.length, 0);
			assert.equal(fired.length, 0);

			settleRun(chatId, []);
			await delivery;
			assert.deepEqual(fired.map((s) => s[0]!.id), [handoff.id]);
		});

		it("registerLiveAgent synchronously steers pending markers into the new run (parked-behind-quiz path)", async () => {
			const { chatId, steer } = setup();
			const { handed, agent } = fakeAgent();
			const fired = captureWakes();
			chatStore.saveMessages(chatId, [...nativeToolMessages("teach me", "probe_done", "call-q", { ok: true }), quizCall("a-q")]);
			const delivery = deliverJobResult(steer);
			await delay(300); // let the pump park behind the dangling question
			assert.equal(handed.length, 0);

			assert.ok(beginTurn(chatId));
			registerLiveAgent(chatId, agent);
			assert.deepEqual(handed.map((m) => m.id), [steer.id], "registration itself steered the marker in");

			settleRun(chatId, [steer]);
			await delivery;
			assert.equal(fired.length, 0, "the run delivered; the parked wake never fired");
		});
	});
});

describe("persistTurn (native history)", () => {
	it("stamps empty ids, preserves existing ones, and appends only the turn's tail", () => {
		const chatId = newChat("persist stamps ids", [userMsg("base_1", "first")]);
		const stamped = persistTurn(chatStore, chatId, 1, [
			userMsg("base_1", "first"),
			userMsg("", "wake turn"),
			assistantMsg("msg_kept", [{ type: "text", text: "hi" }], "stop"),
		], false);
		assert.equal(stamped.length, 2, "only the turn's new tail persists");
		assert.match(stamped[0]!.id, /^msg_/);
		assert.equal(stamped[1]!.id, "msg_kept");
		const record = chatStore.getChat(chatId)!;
		assert.deepEqual(record.messages.map((m) => m.id), ["base_1", stamped[0]!.id, "msg_kept"]);
	});

	it("drops clean question placeholders, keeps errored results", () => {
		const chatId = newChat("persist placeholder filtering");
		const stamped = persistTurn(chatStore, chatId, 0, [
			assistantMsg("", [{ type: "toolCall", id: "q1", name: "quiz", arguments: { question: "q?" } }]),
			toolResult("q1", "quiz", "question posed", "question posed", false, ""),
			toolResult("q1", "quiz", "bad options", "bad options", true, ""),
		], false);
		assert.equal(stamped.length, 2);
		const record = chatStore.getChat(chatId)!;
		assert.equal(record.messages.length, 2);
		assert.equal((record.messages[1] as { isError: boolean }).isError, true);
	});
});

describe("prompt composition", () => {
	it("composes the base prompt then every numeric fragment verbatim, never README, within size guards", () => {
		const instructions = composeInstructions("teacher");
		assert.ok(!instructions.includes("Prompt fragments"), "README content must not leak");
		assert.ok(instructions.startsWith(fs.readFileSync("src/agent/system-prompt.md", "utf-8").trim()));
		for (const f of fs.readdirSync("src/agent/prompts").filter((f) => /^\d+-[\w.-]+\.md$/.test(f))) {
			const body = fs.readFileSync(`src/agent/prompts/${f}`, "utf-8").trim();
			assert.ok(instructions.includes(body), `fragment ${f} must compose verbatim`);
			assert.ok(body.length <= 8_000, `fragment ${f} is over the 8k guard`);
		}
		assert.ok(instructions.length <= 60_000, "composed system prompt over the 60k guard");
	});
});

describe("abort (abortJob)", () => {
	it("kills the running loop: error \"Aborted by learner\" at once, no result, teacher gets the abort steer", async () => {
		const { jobId } = researchJob("abort running job", "call-abort1");
		const fired = captureWakes();
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: async () => {
				throw new Error("a cancelled job must never deliver a result steer");
			},
		});
		await withModel(researchModelOverride, fauxEngine([abortableFactory()]), async () => {
			const settled = runner.runJob(jobId, RESEARCH_INPUT);
			await waitFor(() => jobStore.getJob(jobId)!.activity === "researching", 8000, "loop started");

			assert.ok(abortJob(jobId).ok);
			const killed = jobStore.getJob(jobId)!;
			assert.equal(killed.status, "error", "flipped synchronously");
			assert.equal(killed.error, "Aborted by learner");

			await settled;
			const unwound = jobStore.getJob(jobId)!;
			assert.equal(unwound.status, "error", "the runner never overwrites the flip");
			assert.equal(unwound.result, undefined);

			await waitFor(() => fired.length > 0, 8000, "abort wake fired");
			const steer = fired[0]![0]!;
			assert.equal(steer.id, `steer_${jobId}`);
			assert.equal(steer.customType, "subagent-abort");
			assert.equal(jobStore.getJob(jobId)!.status, "error", "terminal after the wake");
		});
	});

	it("usage folded so far survives the kill", async () => {
		const { jobId } = researchJob("abort keeps usage", "call-abort2");
		const runner = createJobRunner({ chatStore, jobStore, deliver: async () => {}, searchProvider: () => stubSearch() });
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "anything" }, { id: "ws1" })], { stopReason: "toolUse" }),
			abortableFactory(),
		]);
		await withModel(researchModelOverride, engine, async () => {
			const settled = runner.runJob(jobId, RESEARCH_INPUT);
			await waitFor(() => (jobStore.getJob(jobId)!.usage?.steps ?? 0) === 1, 8000, "first step folded");
			abortJob(jobId);
			await settled;
		});
		const job = jobStore.getJob(jobId)!;
		assert.equal(job.error, "Aborted by learner");
		assert.equal(job.usage!.steps, 1);
		assert.equal(job.usage!.model, "faux:faux-1", "stamped with the engine's actual model");
		assert.ok(job.usage!.inputTokens! > 0 && job.usage!.outputTokens! > 0);
	});

	it("a finished worker with a queued result is not abortable and still delivers once", async () => {
		const chatId = newChat("abort delivering job", [userMsg("u1", "hello")]);
		const job = newJob(chatId, "research", "call-abort3");
		const result: ResearchResult = { brief: "Done: it works.", sources: [] };
		jobStore.updateJob(job.id, { result, status: "done", activity: "finished", delivery: { kind: "result", status: "pending" } });

		assert.ok(beginTurn(chatId)); // block the pump so the steer sits queued
		const fired = captureWakes();
		void deliverJobResult(buildSubagentSteer(job, result)).catch(() => {});

		assert.deepEqual(abortJob(job.id), { ok: false, reason: "not_running" });
		assert.equal(jobStore.getJob(job.id)!.error, undefined);

		endTurn(chatId);
		await waitFor(() => fired.length > 0, 8000, "wake fired");
		assert.equal(fired.length, 1);
		assert.equal(fired[0]![0]!.customType, "subagent-steer");
		assert.equal(jobStore.getJob(job.id)!.status, "done");
	});

	it("an unknown job id is not_found", () => {
		assert.deepEqual(abortJob("job_does_not_exist"), { ok: false, reason: "not_found" });
	});
});

// The sweep keys on the abort registry (isJobLive), not record age: without
// a live registration a running record is an orphan and recovers at once.
describe("stale-job recovery sweep (liveness-gated)", () => {
	let sweepN = 0;
	function orphanJob(withResult?: ResearchResult): string {
		const job = newJob(newChat("stale sweep", [userMsg("u1", "hello")]), "research", `call-sweep-${sweepN++}`);
		if (withResult) jobStore.updateJob(job.id, { result: withResult, activity: "delivering result" });
		return job.id;
	}

	/** Run the sweep (its 30s throttle reset); the ids it respawned. */
	function sweep(): string[] {
		const respawned: string[] = [];
		setJobRespawn((id) => respawned.push(id));
		const g = globalThis as { __lhWakePipeline?: { lastSweepAt: number } };
		if (g.__lhWakePipeline) g.__lhWakePipeline.lastSweepAt = 0;
		recoverStaleJobs();
		return respawned;
	}

	it("a running record with a live loop registration is never recovered, however old", () => {
		const jobId = orphanJob();
		jobStore.updateJob(jobId, { updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() });
		registerJobAbort(jobId, new AbortController());
		assert.ok(!sweep().includes(jobId), "no respawn beside a live loop");
		assert.equal(jobStore.getJob(jobId)!.activity, "starting");
	});

	it("an orphan without a registration is re-spawned immediately", () => {
		const jobId = orphanJob();
		assert.ok(sweep().includes(jobId));
		assert.equal(jobStore.getJob(jobId)!.activity, "recovering: re-running");
	});

	it("an orphan with a stored result is re-delivered and settles done", async () => {
		const jobId = orphanJob({ brief: "Done: it works.", sources: [] });
		const fired = captureWakes();
		sweep();
		await waitFor(() => fired.length > 0, 8000, "recovery wake fired");
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "orphan settled");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});
});

describe("composer steering: steerLiveChat + deliver-or-requeue", () => {
	const fakeAgent = () => {
		const handed: { id: string }[] = [];
		return { handed, agent: { steer: (m: { id: string }) => handed.push(m) } as never };
	};
	const steerMsg = (id: string, timestamp = 1) => ({ id, role: "user", content: id, timestamp }) as never;

	it("no live turn → false, nothing parked", () => {
		const chatId = newChat("steer idle");
		assert.equal(steerLiveChat(chatId, steerMsg("steer_x1")), false);
		const { handed, agent } = fakeAgent();
		registerLiveAgent(chatId, agent);
		assert.equal(handed.length, 0);
		unregisterLiveAgent(chatId);
	});

	it("live agent → steered once (re-registering never re-hands); stranded steers ride the next run", () => {
		const chatId = newChat("steer reconcile");
		const delivered = steerMsg("steer_d1");
		const stranded = steerMsg("steer_s1", 2);
		const first = fakeAgent();
		registerLiveAgent(chatId, first.agent);
		assert.equal(steerLiveChat(chatId, delivered), true);
		assert.equal(steerLiveChat(chatId, stranded), true);
		registerLiveAgent(chatId, first.agent);
		assert.deepEqual(first.handed.map((m) => m.id), ["steer_d1", "steer_s1"]);

		// The run persisted only the delivered one.
		unregisterLiveAgent(chatId);
		reconcileUserSteers(chatId, [delivered]);
		const next = fakeAgent();
		registerLiveAgent(chatId, next.agent);
		assert.deepEqual(next.handed.map((m) => m.id), ["steer_s1"]);
		unregisterLiveAgent(chatId);
		reconcileUserSteers(chatId, [stranded, delivered]);
	});
});
