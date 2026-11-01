
/**
 * Demo + visual artifact tests (W6) — deterministic, zero network, no real
 * Chrome: bridge reducer, steer-card safety, the demo-builder and
 * visual-maker loops (fake model + fake headless), job runners + dispatch,
 * and the dispatch tool schemas.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim (see render-cards.test.tsx)

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { Value } from "typebox/value";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { renderToStaticMarkup } from "react-dom/server";
import { PATHS } from "../config.ts";
import { buildDemoSrcDoc, INITIAL_DEMO_BRIDGE_STATE, reduceDemoBridgeState } from "../components/artifacts/demo-card.tsx";
import { sanitizeSvg, svgNaturalWidth } from "../components/artifacts/visual-card.tsx";
import { slugFilename } from "../components/artifacts/download.ts";
import { chartSize } from "../components/session-overlay.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { demoInputSchema, jobTools, pdfInputSchema, visualInputSchema } from "../src/agent/tools/jobs.ts";
import { runDemoBuilder } from "../src/agent/subagents/demo-builder.ts";
import { headlessOverride, type DemoRunResult, type HeadlessApi } from "../src/agent/subagents/headless.ts";
import { createJobRunner, demoModelOverride, visualModelOverride } from "../src/agent/subagents/runner.ts";
import { runVisualMaker } from "../src/agent/subagents/visual-maker.ts";
import { buildAbortSteer, buildSubagentSteer, isSubagentFailure, setSteerUiInverted, type SteerMessage } from "../src/core/contracts.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import type { PiEngine } from "../src/agent/models.ts";

/**
 * A fake deliver seam + a runner wired like the chat-handler's, per test:
 * capture the steer and mimic the pipeline's final status flip so the job
 * record reads exactly as production does after the wake turn completes.
 */
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

// The key-presence turn gate (provider-key interlude, 2026-09-25): scripted
// turns pin openrouter per chat — the gate reads env-first truth, so the
// key must be present in the test process like any real setup.
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

/** A scripted pi engine (faux provider): the response queue replaces the old
 *  doGenerate turn counter — one queued response per model call (tool-call
 *  turn or final text), consumed in order. */
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

// ─── fake headless ───────────────────────────────────────────────────────────

const CLEAN_RUN: DemoRunResult = { consoleErrors: [], pageErrors: [], failedRequests: [], ok: true };
const BROKEN_RUN: DemoRunResult = { consoleErrors: ["Uncaught ReferenceError: foo is not defined"], pageErrors: [], failedRequests: [], ok: false };

function fakeHeadless(opts: {
	/** Return BROKEN_RUN for html matching this substring, else CLEAN_RUN. */
	brokenWhenIncludes?: string;
	/** Throw for the first N renderSvg calls (then succeed). */
	renderFailures?: number;
} = {}): HeadlessApi & { demoRuns: string[]; svgRenders: string[] } {
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
			if (opts.renderFailures && api.svgRenders.length <= opts.renderFailures) {
				throw new Error("XML parse error");
			}
			// The shared native image processor decodes renders, so a signature
			// alone is no longer a successful fake raster.
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

// ─── 1. bridge injection + reducer ───────────────────────────────────────────

describe("demo bridge", () => {
	it("injects the bridge before </body> and keeps the original content", () => {
		const srcDoc = buildDemoSrcDoc("<!doctype html><html><body><canvas id=\"c\"></canvas></body></html>");
		assert.ok(srcDoc.indexOf("demo-resize") !== -1 && srcDoc.indexOf("demo-resize") < srcDoc.indexOf("</body>"));
		assert.match(srcDoc, /<canvas id="c">/);
	});

	it("appends the bridge when the document has no </body>", () => {
		const srcDoc = buildDemoSrcDoc("<div>fragment demo</div>");
		assert.match(srcDoc, /demo-resize/);
		assert.ok(srcDoc.endsWith("</script>"));
		assert.match(srcDoc, /fragment demo/);
	});

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

// ─── 2. card rendering ───────────────────────────────────────────────────────

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
		assert.match(html, /demo-resize/);
		assert.match(html, /demo-error/);
	});

	it("renders the failure note with no artifact when a demo or visual build FAILED", () => {
		const demo = buildSubagentSteer({ id: "jd", kind: "demo", toolCallId: "cd" }, { title: "T", html: "", tested: true, notes: "FAILED: never passed verification" });
		const demoHtml = renderToStaticMarkup(<SubagentSteerCard message={projectNative([demo])[0] as never} />);
		assert.match(demoHtml, /FAILED: never passed verification/);
		assert.ok(!demoHtml.includes("<iframe"), "no iframe for a failed build");
		const visual = buildSubagentSteer({ id: "jv", kind: "visual", toolCallId: "cv" }, { svg: "", notes: "FAILED: iteration limit" });
		const visualHtml = renderToStaticMarkup(<SubagentSteerCard message={projectNative([visual])[0] as never} />);
		assert.match(visualHtml, /FAILED: iteration limit/);
		assert.ok(!visualHtml.includes("<svg"), "no svg for a failed build");
	});

	it("renders the verified svg inline; the maker's notes are glue and stay hidden", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><circle cx="50" cy="50" r="20"/></svg>';
		const steer = buildSubagentSteer({ id: "jv", kind: "visual", toolCallId: "cv" }, { svg, notes: "Looking at the render, the diagram is clean." });
		const html = renderToStaticMarkup(<SubagentSteerCard message={projectNative([steer])[0] as never} />);
		assert.ok(html.includes("circle"), "svg content rendered inline");
		assert.ok(!html.includes("Looking at the render"), "model-facing notes never render");
	});

	it("the abort chip renders off the marker PART, not metadata", () => {
		const view = projectNative([buildAbortSteer({ id: "jc", kind: "research", toolCallId: "cc" })])[0]!;
		const html = renderToStaticMarkup(<SubagentSteerCard message={{ ...view, metadata: {} } as never} />);
		assert.match(html, /job-aborted-badge/);
	});
});

describe("svg helpers + invert switch", () => {
	it("svgNaturalWidth: declared px sizes parse; %, auto, viewBox-only, and zero fall back to null", () => {
		assert.equal(svgNaturalWidth('<svg width="200" height="100"></svg>'), 200);
		assert.equal(svgNaturalWidth("<svg width='320'></svg>"), 320);
		for (const s of ['<svg width="100%"></svg>', '<svg width="auto"></svg>', '<svg viewBox="0 0 10 10"></svg>', '<svg width="0"></svg>']) {
			assert.equal(svgNaturalWidth(s), null, s);
		}
	});

	it("slugFilename: titles slug to filename stems; symbol-only falls back", () => {
		assert.equal(slugFilename("Ünïcode — Tïtle!"), "unicode-title");
		assert.equal(slugFilename("???"), "demo");
	});

	it("chartSize: width/height attrs are the fallback; viewBox always wins", () => {
		assert.deepEqual(chartSize('<svg width="320" height="240"></svg>'), { w: 320, h: 240 });
		assert.deepEqual(chartSize('<svg width="50px" height="25px" viewBox="0 0 100 50"></svg>'), { w: 100, h: 50 });
	});

	it("setSteerUiInverted writes ui.inverted on the target only; a missing target is identity", () => {
		const demoSteer = buildSubagentSteer({ id: "jx", kind: "demo", toolCallId: "cx" }, { title: "T", html: "<p>x</p>", tested: true });
		const other = { id: "other", role: "user" as const, content: "hi", timestamp: 1 };
		const on = setSteerUiInverted([other, demoSteer], demoSteer.id, true);
		assert.deepEqual((on[1] as { details: { ui?: { inverted?: boolean } } }).details.ui, { inverted: true });
		assert.equal(on[0], other, "untouched messages pass through by identity");
		const off = setSteerUiInverted(on, demoSteer.id, false);
		assert.equal((off[1] as { details: { ui?: { inverted?: boolean } } }).details.ui?.inverted, false);
		assert.equal(setSteerUiInverted([demoSteer], "nope", true)[0], demoSteer, "no target → identity");
	});
});

describe("sanitizeSvg", () => {
	it("strips script blocks, event handlers, and javascript: urls, keeps geometry", () => {
		const dirty = '<svg width="10" height="10" onload="alert(1)"><script>alert(2)</script><circle r="1" onclick="pwn()"/><a href="javascript:alert(3)"><rect width="2" height="2"/></a></svg>';
		const clean = sanitizeSvg(dirty);
		assert.ok(!/<script/i.test(clean), "script tags removed");
		assert.ok(!/\sonload/i.test(clean), "onload removed");
		assert.ok(!/\sonclick/i.test(clean), "onclick removed");
		assert.ok(!/javascript:/i.test(clean), "javascript: urls removed");
		assert.ok(clean.includes("circle") && clean.includes("rect"), "geometry preserved");
	});
});

// ─── 3. the demo-builder loop ────────────────────────────────────────────────

const BROKEN_HTML = "<!doctype html><html><body>BROKEN<script>foo();</script></body></html>";
const GOOD_HTML = "<!doctype html><html><body><canvas id=\"c\"></canvas><script>requestAnimationFrame(function step(){});</script></body></html>";

describe("demo builder (fake model + fake headless)", () => {
	it("iterates write → run → fix → run → clean → delivers with notes", async () => {
		const headless = fakeHeadless({ brokenWhenIncludes: "BROKEN" });
		const activities: string[] = [];
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: BROKEN_HTML } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "run_demo", input: {} }] },
			{ toolCalls: [{ toolCallId: "w2", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ toolCalls: [{ toolCallId: "r2", toolName: "run_demo", input: { probe: "typeof step === 'function'" } }] },
			{ text: "Drag the damping slider to see the oscillation decay." },
		]);

		const result = await runDemoBuilder(
			{ title: "Damped oscillator", brief: "A mass on a spring with a damping slider." },
			{ engine: model, headless, onActivity: (line) => activities.push(line) },
		);

		assert.equal(result.title, "Damped oscillator");
		assert.equal(result.html, GOOD_HTML, "delivers the FIXED html");
		assert.equal(result.tested, true);
		assert.equal(result.notes, "Drag the damping slider to see the oscillation decay.");
		assert.equal(headless.demoRuns.length, 2, "ran the broken demo, then the fixed one — no extra verification needed");
		assert.ok(activities.some((a) => a.startsWith("run_demo: 1 console error")), `activity recorded per iteration: ${activities.join(" | ")}`);
		assert.ok(activities.includes("run_demo: clean"), "clean run recorded in activity");
	});

	it("verifies headlessly even when the model forgets run_demo before finishing", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ text: "Done." },
		]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: model, headless });
		assert.equal(result.html, GOOD_HTML);
		assert.equal(result.tested, true, "tested by the final verification gate");
		assert.equal(headless.demoRuns.length, 1, "the gate ran the demo once itself");
	});

	it("fails (empty html + FAILED notes) when the demo never passes verification", async () => {
		const headless = fakeHeadless({ brokenWhenIncludes: "BROKEN" });
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: BROKEN_HTML } }] },
			{ text: "It works, trust me." },
		]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: model, headless });
		assert.equal(result.html, "");
		assert.equal(result.tested, true, "the loop ran");
		assert.match(result.notes ?? "", /^FAILED:/);
		assert.match(result.notes ?? "", /ReferenceError/);
	});

	it("fails fast with a clear message when no Chrome is available (never skips testing)", async () => {
		const model = scriptedModel([{ text: "should never be reached" }]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: model, headless: noChromeHeadless() });
		assert.equal(result.html, "");
		assert.match(result.notes ?? "", /^FAILED: .*Chrome/);
	});

	it("fails when the model never writes a demo", async () => {
		const model = scriptedModel([{ text: "I cannot build this." }]);
		const result = await runDemoBuilder({ title: "T", brief: "b" }, { engine: model, headless: fakeHeadless() });
		assert.equal(result.html, "");
		assert.match(result.notes ?? "", /^FAILED: the builder never wrote a demo/);
	});
});

// ─── 4. the visual-maker loop ────────────────────────────────────────────────

const SVG_1 = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><line x1="10" y1="50" x2="290" y2="50"/></svg>';

describe("visual maker (fake model + fake headless)", () => {
	it("write → render → look → finish delivers the svg with notes", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "render_svg", input: {} }] },
			{ text: "A number line from -3 to 3 with the root marked at 0." },
		]);
		const activities: string[] = [];
		const result = await runVisualMaker({ brief: "Number line, root at 0." }, { engine: model, headless, onActivity: (l) => activities.push(l) });

		assert.equal(result.svg, SVG_1);
		assert.equal(result.notes, "A number line from -3 to 3 with the root marked at 0.");
		assert.equal(headless.svgRenders.length, 1);
		assert.ok(activities.some((a) => a.startsWith("render_svg")), "render activity recorded");
	});

	it("forces a look when the model finishes without rendering the final svg", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ text: "Done." }, // premature finish — no render yet
			{ text: "Looked at it — correct." }, // after the forced look
		]);
		const result = await runVisualMaker({ brief: "b" }, { engine: model, headless });
		assert.equal(result.svg, SVG_1, "delivered after the forced look");
		assert.equal(result.notes, "Looked at it — correct.");
		assert.equal(headless.svgRenders.length, 1, "the gate rendered the svg once itself");
	});

	it("edit_svg: exact-match single replacement, with fuzzy context on a miss", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "render_svg", input: {} }] },
			// A miss: old_text not in the document (error fed back, nothing changed)
			{ toolCalls: [{ toolCallId: "e1", toolName: "edit_svg", input: { old_text: "NOT-PRESENT", new_text: "x" } }] },
			// A hit: exactly one occurrence — applied
			{ toolCalls: [{ toolCallId: "e2", toolName: "edit_svg", input: { old_text: '<line x1="10"', new_text: '<line x1="20"' } }] },
			{ toolCalls: [{ toolCallId: "r2", toolName: "render_svg", input: {} }] },
			{ text: "Moved the start of the line." },
		]);
		const result = await runVisualMaker({ brief: "b" }, { engine: model, headless });

		assert.equal(result.svg, SVG_1.replace('<line x1="10"', '<line x1="20"'), "the edit was applied to the delivered svg");
		assert.equal(result.notes, "Moved the start of the line.");
		assert.equal(headless.svgRenders.length, 2, "re-rendered after the edit (the look gate saw the change)");
	});

	it("edit_svg before write_svg errors and never edits nothing into a deliverable", async () => {
		const headless = fakeHeadless();
		const model = scriptedModel([
			// Nothing written yet — the edit must error, not crash the loop
			{ toolCalls: [{ toolCallId: "e0", toolName: "edit_svg", input: { old_text: "svg", new_text: "x" } }] },
			{ text: "Cannot proceed." },
		]);
		const result = await runVisualMaker({ brief: "b" }, { engine: model, headless });
		assert.equal(result.svg, "", "the failed edit produced no deliverable");
		assert.match(result.notes ?? "", /never wrote an SVG/);
	});

	it("feeds render errors back to the model instead of crashing", async () => {
		const headless = fakeHeadless({ renderFailures: 1 });
		const model = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_svg", input: { svg: "<svg>broken" } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "render_svg", input: {} }] },
			{ toolCalls: [{ toolCallId: "w2", toolName: "write_svg", input: { svg: SVG_1 } }] },
			{ toolCalls: [{ toolCallId: "r2", toolName: "render_svg", input: {} }] },
			{ text: "Fixed and verified." },
		]);
		const result = await runVisualMaker({ brief: "b" }, { engine: model, headless });
		assert.equal(result.svg, SVG_1);
		assert.equal(result.notes, "Fixed and verified.");
	});

	it("fails with a clear message when no Chrome is available", async () => {
		const result = await runVisualMaker({ brief: "b" }, { engine: scriptedModel([{ text: "x" }]), headless: noChromeHeadless() });
		assert.equal(result.svg, "");
		assert.match(result.notes ?? "", /^FAILED: .*Chrome/);
	});
});

// ─── 5. job runners + dispatch ───────────────────────────────────────────────

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

/** CONNECTION DIET B (owner, 2026-10-10): the POST acks and closes; drain
 *  the turn's wire through the reattach stream instead (settle-tolerant:
 *  a short turn may finish inside the handler). */
async function drainRunning(chatId: string): Promise<string> {
	const handle = runningTurn(chatId);
	if (!handle) return ""; // the turn already settled — completion happened
	return new Response(handle.subscribe()).text();
}

/** Seed a chat whose assistant called `name` and got the dispatch ack back
 *  (a NATIVE fixture — the runner's transcript scan reads it through the projection). */
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
	it("runJob completes a demo: result on the job, steer via deliver, ack stays on the part", async () => {
		const chat = seedDispatchedChat("Test: demo runner", "demo", "call-d1", DEMO_INPUT);
		const job = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "call-d1" });
		createdJobs.push(job.id);

		// runJob has no headless injection point — the module override is the seam.
		headlessOverride.current = fakeHeadless();
		demoModelOverride.current = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_demo", input: { html: GOOD_HTML } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "run_demo", input: {} }] },
			{ text: "Sweep the rate slider." },
		]);
		const { steers, runner } = testRunner();
		try {
			await runner.runJob(job.id);
		} finally {
			headlessOverride.current = undefined;
			demoModelOverride.current = undefined;
		}

		const done = jobStore.getJob(job.id)!;
		assert.equal(done.status, "done");
		const result = done.result as { title: string; html: string; tested: boolean; notes?: string };
		assert.equal(result.title, "Compound interest");
		assert.equal(result.html, GOOD_HTML);
		assert.equal(result.tested, true);

		assert.equal(steers.length, 1, "exactly one steer");
		const data = steers[0]!.details as { kind: string; result: unknown };
		assert.equal(data.kind, "demo");
		assert.deepEqual(data.result, result);

		// The tool part keeps the DISPATCH ACK forever — the result never rewrites it.
		const saved = projectNative(chatStore.getChat(chat.id)!.messages);
		const part = saved[1]!.parts.find((p) => p.type === "tool-demo");
		assert.ok(part && part.type === "tool-demo", "demo tool part persisted");
		assert.equal(typeof (part as { output?: unknown }).output, "string", "part output is the ack, not the result");
	});

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
		// BYOK turn gate (owner, 2026-09-22): the scripted chat needs a
		// conversation model — the per-chat pin, exactly like the setup flow.
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });

		// A teacher that calls demo on turn 1, then continues in the SAME turn.
		const teacher = scriptedModel([
			{ toolCalls: [{ toolCallId: "call-d2", toolName: "demo", input: DEMO_INPUT }] },
			{ text: "Here it is." },
		]);

		// The overrides must be live BEFORE the request — dispatch fires the
		// runner mid-stream, inside the tool execute.
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
						// Wave B: the input-events contract — one event,
						// never a client transcript.
						input: { type: "text", text: "teach me compounding" },
					}),
				}),
				// The handler hands the factory the native build options
				// (messages are the merged record; the record IS the agent
				// state — no adapter conversion).
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

			const job = jobStore.findJobByToolCallId(chat.id, "call-d2");
			assert.ok(job, "dispatch created a job at tool-execute time");
			assert.equal(job!.kind, "demo");
			createdJobs.push(job!.id);

			// The background runner (fire-and-forget) completes with the overrides.
			await waitFor(() => jobStore.getJob(job!.id)!.status !== "running", 8000, "demo job completion");
			const done = jobStore.getJob(job!.id)!;
			assert.equal(done.status, "done");

			const saved = projectNative(chatStore.getChat(chat.id)!.messages);
			const part = saved[1]!.parts.find((p) => p.type === "tool-demo");
			assert.ok(part && part.type === "tool-demo", "demo tool part persisted");
			assert.equal(part.state, "output-available", "the part resolved with the ack at dispatch time");
			assert.match(String((part as { output?: unknown }).output), /fire-and-forget/);

			assert.equal(steers.length, 1, "one job, one steer");
			assert.equal((steers[0]!.details as { jobId: string }).jobId, job!.id);

			// Idempotency: dispatch dedupes by toolCallId — no second job.
			assert.equal(jobStore.listJobs(chat.id).length, 1, "no duplicate job for the same tool part");
		} finally {
			demoModelOverride.current = undefined;
			headlessOverride.current = undefined;
		}
	});
});

// ─── 6. registry wiring ──────────────────────────────────────────────────────

describe("dispatch tool registry", () => {
	it("demo and visual are SERVER-EXECUTED dispatch tools with the contract schemas", () => {
		const { runner } = testRunner();
		const tools = jobTools({ chatId: "chat_registry", jobStore, spawn: (job) => void runner.runJob(job.id) });
		assert.deepEqual(Object.keys(tools).sort(), ["demo", "pdf", "research", "visual"]);
		for (const name of ["demo", "visual", "research", "pdf"] as const) {
			assert.equal(typeof (tools[name] as { execute?: unknown }).execute, "function", `${name} executes server-side — fire-and-forget ack per THE ASYNC PROTOCOL`);
		}
		assert.equal(Value.Check(demoInputSchema, { title: "T", brief: "b" }), true);
		assert.equal(Value.Check(demoInputSchema, { brief: "b" }), false, "demo requires a title");
		assert.equal(Value.Check(visualInputSchema, { brief: "b" }), true);
		assert.equal(Value.Check(visualInputSchema, {}), false, "visual requires a brief");
		assert.equal(Value.Check(pdfInputSchema, { path: "/tmp/doc.pdf", question: "q" }), true);
		assert.equal(Value.Check(pdfInputSchema, { question: "q" }), false, "pdf requires a path");
		assert.equal(Value.Check(pdfInputSchema, { path: "/tmp/doc.pdf" }), false, "pdf requires a question");
	});
});
