import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim (see render-cards.test.tsx)

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { renderToStaticMarkup } from "react-dom/server";
import { PATHS } from "../config.ts";
import { INITIAL_DEMO_BRIDGE_STATE, reduceDemoBridgeState } from "../components/artifacts/demo-card.tsx";
import { sanitizeSvg } from "../components/artifacts/visual-card.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { runDemoBuilder } from "../src/agent/subagents/demo-builder.ts";
import { headlessOverride, type DemoRunResult, type HeadlessApi } from "../src/agent/subagents/headless.ts";
import { createJobRunner, demoModelOverride, visualModelOverride } from "../src/agent/subagents/runner.ts";
import { runVisualMaker } from "../src/agent/subagents/visual-maker.ts";
import { buildSubagentSteer, isSubagentFailure, type SteerMessage } from "../src/core/contracts.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import type { PiEngine } from "../src/agent/models.ts";

/** Fake deliver seam that mimics the pipeline's final status flip. */
function testRunner() {
	const steers: SteerMessage[] = [];
	const runner = createJobRunner({
		chatStore,
		jobStore,
		deliver: async (steer) => {
			steers.push(steer);
			const jobId = (steer.details as { jobId: string }).jobId;
			const job = jobStore.getJob(jobId);
			if (job && job.status === "running") {
				const failed = job.result ? isSubagentFailure(job.kind, job.result as never) : true;
				jobStore.updateJob(jobId, { status: failed ? "error" : "done", activity: failed ? "failed" : "delivered" });
			}
		},
	});
	return { steers, runner };
}

// The key-presence turn gate needs a provider key in env.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const JOBS_DIR = path.join(PATHS.data, "jobs");
const createdChats: string[] = [];
const createdJobs: string[] = [];

after(() => {
	for (const id of createdChats) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
	for (const id of createdJobs) fs.rmSync(path.join(JOBS_DIR, `${id}.json`), { force: true });
	headlessOverride.current = undefined;
	demoModelOverride.current = undefined;
	visualModelOverride.current = undefined;
});

/** Scripted pi engine: one queued response per model call. */
function scriptedModel(turns: Array<{ toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>; text?: string }>): PiEngine {
	const steps: FauxResponseStep[] = turns.map((step) => {
		if (step.toolCalls) {
			return fauxAssistantMessage(
				step.toolCalls.map((c) => fauxToolCall(c.toolName, c.input as ToolCall["arguments"], { id: c.toolCallId })),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage(step.text ?? "");
	});
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const CLEAN_RUN: DemoRunResult = { consoleErrors: [], pageErrors: [], failedRequests: [], ok: true };
const BROKEN_RUN: DemoRunResult = { consoleErrors: ["Uncaught ReferenceError: foo is not defined"], pageErrors: [], failedRequests: [], ok: false };

function fakeHeadless(opts: { brokenWhenIncludes?: string } = {}): HeadlessApi & { demoRuns: string[]; svgRenders: string[] } {
	const api = {
		demoRuns: [] as string[],
		svgRenders: [] as string[],
		available: () => true,
		unavailableReason: () => null,
		async runDemo(html: string): Promise<DemoRunResult> {
			api.demoRuns.push(html);
			return opts.brokenWhenIncludes && html.includes(opts.brokenWhenIncludes) ? BROKEN_RUN : CLEAN_RUN;
		},
		async renderSvg(svg: string): Promise<Buffer> {
			api.svgRenders.push(svg);
			const canvas = createCanvas(1, 1);
			canvas.getContext("2d").fillRect(0, 0, 1, 1);
			return canvas.toBuffer("image/png");
		},
	};
	return api as HeadlessApi & { demoRuns: string[]; svgRenders: string[] };
}

function noChromeHeadless(): HeadlessApi {
	const never = async (): Promise<never> => {
		throw new Error("should not run");
	};
	return { available: () => false, unavailableReason: () => "No Chrome/Chromium found for headless testing.", runDemo: never, renderSvg: never, renderPdfPages: never };
}

describe("demo bridge", () => {
	it("reduceDemoBridgeState clamps resize, records errors, ignores garbage", () => {
		let state = INITIAL_DEMO_BRIDGE_STATE;
		state = reduceDemoBridgeState(state, { type: "demo-resize", height: 421.7 });
		assert.equal(state.height, 422);
		assert.equal(reduceDemoBridgeState(state, { type: "demo-resize", height: 99999 }).height, 2400);
		state = reduceDemoBridgeState(state, { type: "demo-resize", height: 5 });
		assert.equal(state.height, 80);
		assert.equal(reduceDemoBridgeState(state, { type: "demo-resize", height: "tall" }).height, 80);
		state = reduceDemoBridgeState(state, { type: "demo-error", message: "x is not defined" });
		assert.equal(state.error, "x is not defined");
		assert.equal(state.height, 80, "error does not clobber height");
		assert.equal(reduceDemoBridgeState(state, { type: "demo-error" }).error, "unknown error");
		for (const garbage of [{ type: "something-else" }, "demo-resize", null]) {
			assert.deepEqual(reduceDemoBridgeState(state, garbage), state);
		}
	});
});

const DEMO_HTML = "<!doctype html><html><body><h1>oscillator</h1><script>let t=0;</script></body></html>";

describe("steer card rendering (the delivered artifact)", () => {
	it("renders a sandboxed demo iframe (allow-scripts, NO allow-same-origin) with the bridge injected", () => {
		const steer = buildSubagentSteer(
			{ id: "jd", kind: "demo", toolCallId: "cd" },
			{ title: "Damped oscillator", html: DEMO_HTML, tested: true },
		);
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectNative([steer])[0] as never} />);
		assert.match(html, /sandbox="allow-scripts"/);
		assert.ok(!html.includes("allow-same-origin"), "never allow-same-origin");
	});

	it("renders the failure note with no artifact when a build FAILED", () => {
		const demo = buildSubagentSteer({ id: "jd", kind: "demo", toolCallId: "cd" }, { title: "T", html: "", tested: true, notes: "FAILED: never passed verification" });
		const demoHtml = renderToStaticMarkup(<SubagentSteerCard message={projectNative([demo])[0] as never} />);
		assert.match(demoHtml, /FAILED: never passed verification/);
		assert.ok(!demoHtml.includes("<iframe"), "no iframe for a failed build");
	});
});

describe("sanitizeSvg", () => {
	it("strips script blocks, event handlers, and javascript: urls, keeps geometry", () => {
		const dirty = '<svg width="10" height="10" onload="alert(1)"><script>alert(2)</script><circle r="1" onclick="pwn()"/><a href="javascript:alert(3)"><rect width="2" height="2"/></a></svg>';
		const clean = sanitizeSvg(dirty);
		assert.ok(!/<script|\sonload|\sonclick|javascript:/i.test(clean), "scripts, handlers and javascript: urls removed");
		assert.ok(clean.includes("circle") && clean.includes("rect"), "geometry preserved");
	});
});

const BROKEN_HTML = "<!doctype html><html><body>BROKEN<script>foo();</script></body></html>";
const GOOD_HTML = "<!doctype html><html><body><canvas id=\"c\"></canvas><script>requestAnimationFrame(function step(){});</script></body></html>";

describe("demo builder (fake model + fake headless)", () => {
	it("iterates write → run → fix → run → clean → delivers the fixed html", async () => {
		const headless = fakeHeadless({ brokenWhenIncludes: "BROKEN" });
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: BROKEN_HTML } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "run_demo", input: {} }] },
			{ toolCalls: [{ toolCallId: "w2", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ toolCalls: [{ toolCallId: "r2", toolName: "run_demo", input: {} }] },
			{ text: "Drag the damping slider." },
		]);
		const result = await runDemoBuilder({ title: "Damped oscillator", brief: "b" }, { engine: model, headless });
		assert.deepEqual([result.html, result.tested, headless.demoRuns.length], [GOOD_HTML, true, 2]);
	});

	it("verifies headlessly even when the model forgets run_demo before finishing", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ text: "Done." },
		]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: model, headless });
		assert.deepEqual([result.html, result.tested, headless.demoRuns.length], [GOOD_HTML, true, 1]);
	});

	it("fails (empty html + FAILED notes) when the demo never passes verification", async () => {
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: BROKEN_HTML } }] },
			{ text: "It works, trust me." },
		]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: model, headless: fakeHeadless({ brokenWhenIncludes: "BROKEN" }) });
		assert.equal(result.html, "");
		assert.match(result.notes ?? "", /^FAILED:.*ReferenceError/s);
	});

	it("fails with a clear note when Chrome is missing or no demo was written", async () => {
		for (const [headless, note] of [[noChromeHeadless(), /^FAILED: .*Chrome/], [fakeHeadless(), /^FAILED: the builder never wrote a demo/]] as const) {
			const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: scriptedModel([{ text: "no." }]), headless });
			assert.equal(result.html, "");
			assert.match(result.notes ?? "", note);
		}
	});
});

const SVG_1 = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><line x1="10" y1="50" x2="290" y2="50"/></svg>';

describe("visual maker (fake model + fake headless)", () => {
	it("a finish without rendering the final svg forces a look before delivery", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ text: "Done." },
			{ text: "Looked at it — correct." },
		]);
		const result = await runVisualMaker({ brief: "b" }, { engine: model, headless });
		assert.deepEqual([result.svg, result.notes, headless.svgRenders.length], [SVG_1, "Looked at it — correct.", 1]);
	});

	it("edit_svg: exact-match replacement after a miss, then re-render", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "render_svg", input: {} }] },
			{ toolCalls: [{ toolCallId: "e1", toolName: "edit_svg", input: { old_text: "NOT-PRESENT", new_text: "x" } }] },
			{ toolCalls: [{ toolCallId: "e2", toolName: "edit_svg", input: { old_text: '<line x1="10"', new_text: '<line x1="20"' } }] },
			{ toolCalls: [{ toolCallId: "r2", toolName: "render_svg", input: {} }] },
			{ text: "Moved the start of the line." },
		]);
		const result = await runVisualMaker({ brief: "b" }, { engine: model, headless });
		assert.equal(result.svg, SVG_1.replace('<line x1="10"', '<line x1="20"'));
		assert.equal(headless.svgRenders.length, 2);
	});

	it("fails with a clear note when Chrome is missing", async () => {
		const noChrome = await runVisualMaker({ brief: "b" }, { engine: scriptedModel([{ text: "x" }]), headless: noChromeHeadless() });
		assert.equal(noChrome.svg, "");
		assert.match(noChrome.notes ?? "", /^FAILED: .*Chrome/);
	});
});

const DEMO_INPUT = { title: "Compound interest", brief: "Slider for rate, curve of growth over 30 years." };

function waitFor(cond: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
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

/** The POST acks and closes; drain the turn through the reattach stream. */
async function drainRunning(chatId: string): Promise<string> {
	const handle = runningTurn(chatId);
	if (!handle) return ""; // the turn already settled — completion happened
	return new Response(handle.subscribe()).text();
}

/** Seed a chat whose assistant called `name` and got the dispatch ack back. */
function seedDispatchedChat(title: string, name: string, callId: string, args: unknown) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", content: "go", timestamp: 1 } as never,
		{
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name, arguments: args as never }],
			api: "openai-completions",
			provider: "openrouter",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: 1,
		} as never,
		{ id: "r1", role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "Dispatched." }], details: "Dispatched.", isError: false, timestamp: 1 } as never,
	]);
	return chat;
}

describe("demo/visual job runners", () => {
	it("runJob still steers on visual failure and the job lands error", async () => {
		const chat = seedDispatchedChat("Test: visual runner failure", "visual", "call-v1", { brief: "b" });
		const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "call-v1" });
		createdJobs.push(job.id);

		visualModelOverride.current = scriptedModel([{ text: "cannot" }]);
		const { steers, runner } = testRunner();
		try {
			await runner.runJob(job.id);
		} finally {
			visualModelOverride.current = undefined;
		}

		const errored = jobStore.getJob(job.id)!;
		assert.equal(errored.status, "error");
		assert.match(errored.error ?? "", /never wrote an SVG/);
		assert.ok(steers[0], "failure still delivers a steer — the teacher learns the outcome");
		const result = (steers[0]!.details as { result: unknown }).result as { svg: string; notes?: string };
		assert.equal(result.svg, "");
		assert.match(result.notes ?? "", /^FAILED:/);
	});

	it("dispatch through a teacher turn: the call acks mid-turn and the runner completes in the background", async () => {
		const chat = chatStore.createChat("Test: demo spawn dispatch");
		createdChats.push(chat.id);
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });

		const teacher = scriptedModel([
			{ toolCalls: [{ toolCallId: "call-d2", toolName: "demo", input: DEMO_INPUT }] },
			{ text: "Here it is." },
		]);

		demoModelOverride.current = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "run_demo", input: {} }] },
			{ text: "Sweep it." },
		]);
		headlessOverride.current = fakeHeadless();
		const { steers, runner } = testRunner();

		try {
			const ack = await handleChatRequest(
				new Request("http://test/api/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						chatId: chat.id,
						input: { type: "text", text: "teach me compounding" },
					}),
				}),
				(opts) =>
					createTeacherAgent(undefined, {
						engine: teacher,
						messages: opts.messages,
						tools: createTeacherTools({
							chatId: chat.id,
							chatStore,
							jobStore,
							spawn: (job, input) => void runner.runJob(job.id, input),
						}),
					}),
			);
			if (ack.status !== 200) assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
			await drainRunning(chat.id);

			const job = jobStore.findJobByToolCallId(chat.id, "call-d2")!;
			createdJobs.push(job.id);
			await waitFor(() => jobStore.getJob(job.id)!.status !== "running", 8000, "demo job completion");
			const done = jobStore.getJob(job.id)!;
			assert.equal(done.status, "done");
			const result = done.result as { title: string; html: string; tested: boolean };
			assert.deepEqual([result.title, result.html, result.tested], ["Compound interest", GOOD_HTML, true]);
			assert.equal(steers.length, 1, "one job, one steer");
			const details = steers[0]!.details as { result: unknown };
			assert.deepEqual(details.result, result);
			assert.equal(jobStore.listJobs(chat.id).length, 1, "no duplicate job for the same tool part");
		} finally {
			demoModelOverride.current = undefined;
			headlessOverride.current = undefined;
		}
	});
});

