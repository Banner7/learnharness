/**
 * Extraction pipeline integration tests: extractor → auditor → merger over an
 * in-memory GraphStore and real chat records (created and deleted here).
 * mergeFindings itself is tested in tests/graph.test.ts.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type FauxResponseStep, type ToolCall, type Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newPlanBlockMessage } from "../src/core/native-messages.ts";
import type {
	AuditVerdicts,
	CoverageEntry,
	ExtractionRunUsage,
	GraphChain,
	GraphNode,
	NotesSource,
	SessionCheckpoint,
	SessionFindings,
} from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import {
	abortExtraction,
	createExtractionPipeline,
	NotesImportError,
	extractionStatuses,
	transcriptView,
	sourceDigest,
	EXTRACTOR_INSTRUCTIONS,
	NOTES_EXTRACTOR_INSTRUCTIONS,
} from "../src/agent/subagents/extraction.ts";
import { getGraph, simplifyChains } from "../src/core/graph.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, providerKeyMissing, type ModelSlotName } from "../src/core/settings.ts";
import { coverageOf, messageViewLines } from "../src/core/coverage.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const createdChats: string[] = [];

/** A scripted pi engine (faux provider); usage is estimated from the text. */
function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** An in-memory GraphStore mirroring the real store's semantics. */
function memoryLedgers() {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const coverage: CoverageEntry[] = [];
	const sources = new Map<string, NotesSource>();
	return {
		appendNode: (n: GraphNode) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n })),
		appendChain: (c: GraphChain) => void chains.push(c),
		readChains: () => chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })),
		appendCheckpoint: (c: SessionCheckpoint) => void checkpoints.push(c),
		readCheckpoints: () => checkpoints.map((c) => ({ ...c })),
		appendCoverage: (e) => void coverage.push({ ...e }),
		readCoverage: () => coverage.map((e) => ({ ...e })),
		upsertSource: (s: NotesSource) => {
			// Mirrors the real store: an upsert KEEPS the existing usage log.
			const prev = sources.get(s.id);
			sources.set(s.id, { ...s, extractions: [...(prev?.extractions ?? [])] });
		},
		readSources: () => [...sources.values()].map((s) => ({ ...s, extractions: [...(s.extractions ?? [])] })),
		deleteSources: (ids: ReadonlySet<string>) => [...ids].reduce((count, id) => count + Number(sources.delete(id)), 0),
		appendSourceUsage: (id: string, entry: ExtractionRunUsage) => {
			const source = sources.get(id);
			if (!source) return;
			if (!source.extractions?.some((r) => r.startedAt === entry.startedAt)) {
				source.extractions = [...(source.extractions ?? []), entry];
			}
		},
		rewriteLedgers: (next) => {
			if (next.nodes) nodes.splice(0, nodes.length, ...next.nodes.map((n) => ({ ...n, provenance: [...n.provenance], aliases: [...n.aliases] })));
			if (next.chains) chains.splice(0, chains.length, ...next.chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })));
			if (next.coverage) coverage.splice(0, coverage.length, ...next.coverage.map((c) => ({ ...c })));
			if (next.checkpoints) checkpoints.splice(0, checkpoints.length, ...next.checkpoints.map((c) => ({ ...c })));
		},
		readPositions: () => ({}),
		writePositions: () => {},
	} satisfies GraphStore;
}

/** A graph node seed (no provenance unless given). */
function seed(id: string, name: string, provenance: GraphNode["provenance"] = [], statement = `statement of ${name}`): GraphNode {
	return { id, name, statement, aliases: [], createdAt: "2026-08-01T00:00:00.000Z", provenance };
}

interface NativeCallDesc {
	name: string;
	toolCallId: string;
	input: Record<string, unknown>;
	output: unknown;
}

function user(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: Date.now() } as never;
}

/** A native assistant message plus one tool result per call. */
function assistant(id: string, items: unknown[]): LhMessage[] {
	const content: unknown[] = [];
	const calls: NativeCallDesc[] = [];
	for (const item of items) {
		const it = item as { type?: string; text?: string };
		if (it && it.type === "text") {
			content.push({ type: "text", text: it.text });
		} else {
			const call = item as NativeCallDesc;
			calls.push(call);
			content.push({ type: "toolCall", id: call.toolCallId, name: call.name, arguments: call.input as never });
		}
	}
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const out: LhMessage[] = [
		{ id, role: "assistant", content, api: "openai-completions", provider: "openrouter", model: "test", usage, stopReason: "stop", timestamp: Date.now() } as never,
	];
	for (const call of calls) {
		out.push({
			id: `r_${call.toolCallId}`, role: "toolResult", toolCallId: call.toolCallId, toolName: call.name,
			content: [{ type: "text", text: "ok" }], details: call.output, isError: false, timestamp: Date.now(),
		} as never);
	}
	return out;
}

function quizPart(toolCallId: string, question: string, correct: boolean): NativeCallDesc {
	return { name: "quiz", toolCallId, input: { question }, output: { kind: "quiz", questionText: question, correct, dontKnow: false, answeredAt: "2026-08-22T01:00:00.000Z" } };
}

/** A session-shaped chat: probe → teaching text (+ plan noise) → check. Teacher
 *  prose lives in a1 (chain rule) and a2 (derivative). */
function fixtureChat() {
	const chat = chatStore.createChat("Extraction fixture");
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, [
		user("u1", "teach me the chain rule"),
		...assistant("a1", [
			{ type: "text", text: "The chain rule composes rates of change along a path." },
			quizPart("probe-1", "What is a derivative, roughly?", false),
		]),
		user("u2", "go on"),
		...assistant("a2", [
			{ type: "text", text: "The derivative measures how fast a function changes." },
			{ name: "plan_init", toolCallId: "p1", input: { nodes: [], edges: [] }, output: { ok: true, tree: { nodes: [], edges: [], currentNodeId: null, doneNodeIds: [], version: 1 } } },
		]),
		user("u3", "check me"),
		...assistant("a3", [quizPart("check-1", "Check", true)]),
	].flat());
	return { chatId: chat.id, record: chatStore.getChat(chat.id)! };
}

/** Five ~1230-token teacher messages: deterministic batches [a1,a2,a3] + [a4,a5]
 *  at the 4096 budget. */
function chunkyChat() {
	const chat = chatStore.createChat("Chunky coverage fixture");
	createdChats.push(chat.id);
	chatStore.saveMessages(
		chat.id,
		[1, 2, 3, 4, 5].flatMap((n) => assistant(`a${n}`, [{ type: "text", text: `topic ${n}: ${"detail ".repeat(700)}${n}` }])),
	);
	return { chatId: chat.id, record: chatStore.getChat(chat.id)! };
}

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(`${PATHS.chats}/${id}.json`);
		} catch {
			/* already gone */
		}
	}
});

/** The fixture session's submit: p1 (anchored a2) ⟹ p2 (anchored a1). */
const FINDINGS = {
	propositions: [
		{ id: "p1", name: "Derivative", statement: "The derivative measures how fast a function changes", aliases: [], messageId: "a2" },
		{ id: "p2", name: "Chain rule", statement: "The chain rule differentiates composed functions by multiplying local rates.", aliases: [], messageId: "a1" },
	],
	chains: [{ premises: ["p1"], conclusion: "p2" }],
};

const NOTES_TEXT = `> [!quote] YOU
> teach me vim

> [!abstract] PI
> Vim always starts in Normal mode — keys are commands, not text.`;

const NOTES_FINDINGS = {
	propositions: [{ id: "p1", name: "Vim normal mode", statement: "Vim starts in Normal mode, where keys are commands.", aliases: [] }],
	chains: [],
} as const;

const NOTES_VERDICT = { links: [], edges: [] } as const;

const toolMessage = (name: string, input: unknown, id = `${name}-call`) =>
	fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id })], { stopReason: "toolUse" });

/** An engine whose ONE response is the `name` tool call; `onCall` fires at the
 *  model call — the observation point for mid-run assertions. */
function submitModel(name: string, input: unknown, onCall?: () => void): PiEngine {
	return fauxEngine([() => {
		onCall?.();
		return toolMessage(name, input);
	}]);
}

/** A submit whose model call has started but resolves only when `gate` opens. */
function gatedSubmitModel(name: string, input: unknown, gate: Promise<void>, onCall?: () => void): PiEngine {
	return fauxEngine([async () => {
		onCall?.();
		await gate;
		return toolMessage(name, input);
	}]);
}

const review = (verdict: unknown = { links: [] }, onCall?: () => void) => submitModel("submit_review", verdict, onCall);

/** The common pipeline shape: direct extractor + auditor engines. */
const pipe = (graphStore: GraphStore, extractor: PiEngine, auditor: PiEngine = review()) =>
	createExtractionPipeline({ chatStore, graphStore, extractor, auditor });

async function until(cond: () => boolean, ms = 2000): Promise<void> {
	for (const t0 = Date.now(); !cond(); ) {
		if (Date.now() - t0 > ms) throw new Error("condition never became true in time");
		await new Promise((r) => setTimeout(r, 2));
	}
}

/** A model call that never resolves until its abort signal fires. */
const hangStep: FauxResponseStep = (_context, options) =>
	new Promise((resolve) => {
		const sig = options?.signal;
		if (sig?.aborted) return resolve(fauxAssistantMessage("late"));
		sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
	});

/** An engine that never calls a tool (the failure path). */
const silentModel = (): PiEngine => fauxEngine([fauxAssistantMessage("I refuse to use tools"), fauxAssistantMessage("…")]);

/** The pipeline sends the source document as the LAST user turn. */
function capturedView(context: unknown): string {
	const messages = (context as { messages?: { role: string; content: string }[] }).messages ?? [];
	const last = [...messages].reverse().find((m) => m.role === "user");
	return typeof last?.content === "string" ? last.content : "";
}

function systemPromptOf(context: Parameters<FauxResponseFactory>[0]): string {
	const system = context.messages.find((message) => message.role === "system");
	assert.ok(system && system.role === "system");
	return typeof system.content === "string" ? system.content : system.content.map((part) => part.text).join("\n");
}

/** Submits FINDINGS anchored to the CURRENT stretch's first TEACHER [id] label,
 *  so multi-batch fixtures never name a passage outside their batch. */
function findingsStep(capture?: (view: string) => void): FauxResponseFactory {
	return (context) => {
		const view = capturedView(context);
		capture?.(view);
		const anchor = /TEACHER \[([^\]]+)\]/.exec(view)?.[1] ?? "a1";
		return toolMessage("submit_findings", { ...FINDINGS, propositions: FINDINGS.propositions.map((p) => ({ ...p, messageId: anchor })) });
	};
}

const passThroughAuditStep = (): FauxResponseStep => () => toolMessage("submit_review", { links: [], edges: [] });

// ─── transcriptView ──────────────────────────────────────────────────────────

describe("transcriptView (teacher prose only)", () => {
	it("renders only the teacher's prose as id-labeled passages — the same seam coverage hashes", () => {
		const { record } = fixtureChat();
		const view = transcriptView(record);
		assert.match(view, /^# Extraction fixture$/m);
		assert.match(view, /^TEACHER \[a1\] The chain rule composes rates of change along a path\.$/m);
		assert.match(view, /^TEACHER \[a2\] The derivative measures how fast a function changes\.$/m);
		assert.doesNotMatch(view, /TEACHER \[a3\]/);
		assert.equal(view.slice(view.indexOf("TEACHER")), record.messages.flatMap((m) => messageViewLines(m, m.id)).join("\n\n"));
		for (const noise of [/teach me the chain rule/, /go on/, /check me/, /### /, /Quiz/, /plan_init/]) assert.doesNotMatch(view, noise);
	});
});

// ─── the pipeline ───────────────────────────────────────────────────────────

describe("the extraction pipeline (extractor → auditor → merger)", () => {
	it("stringified-payload heal: propositions arriving as ONE JSON string still validate and merge", async () => {
		const { chatId } = fixtureChat();
		const extractor = submitModel("submit_findings", { propositions: JSON.stringify(FINDINGS.propositions), chains: FINDINGS.chains });
		assert.deepEqual(await pipe(memoryLedgers(), extractor).runExtraction(chatId), { nodes: 2, chains: 1 });
	});

	it("runs end to end: findings → audit verdict (identity) → deterministic merge + per-message coverage", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		ledgers.appendNode(seed("n_existing", "Derivative", [], "Derivatives measure rates of change"));
		const verdict: AuditVerdicts = { links: [{ id: "p1", linkTo: "n_existing" }] };
		const stats = await pipe(ledgers, submitModel("submit_findings", FINDINGS), review(verdict)).runExtraction(chatId);

		// Verdicts-only: the linked p1 creates no node, p2 creates one.
		assert.deepEqual(stats, { nodes: 1, chains: 1 });
		assert.equal(ledgers.readNodes().length, 3); // pre-seeded + link line + p2's create
		const linkedLines = ledgers.readNodes().filter((n) => n.id === "n_existing");
		assert.ok(linkedLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId && pt.messageId === "a2")), "the link-append carries p1's passage id");
		const created = ledgers.readNodes().find((n) => n.name === "Chain rule")!;
		assert.deepEqual(created.provenance, [{ chatId, messageId: "a1" }]);

		const record = chatStore.getChat(chatId)!;
		const covered = ledgers.readCoverage();
		assert.equal(covered.length, record.messages.filter((m) => messageViewLines(m, m.id).length > 0).length);
		assert.ok(covered.every((c) => c.chatId === chatId && c.fp.length === 64 && c.tokens > 0));
		assert.equal(ledgers.readCheckpoints().length, 0, "the chat path writes coverage, not the legacy checkpoint");
		assert.equal(coverageOf(record.messages, covered, chatId).uncoveredCount, 0);
	});

	it("BYOK refusal: no stage engines anywhere → the run throws before any stage", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		await assert.rejects(createExtractionPipeline({ chatStore, graphStore: ledgers }).runExtraction(chatId), (err: unknown) => {
			assert.ok(err instanceof ModelsNotConfiguredError);
			assert.deepEqual(err.envelope.missing, ["cheap"]);
			assert.equal(err.envelope.code, "models_not_configured");
			return true;
		});
		assert.equal(ledgers.readCoverage().length, 0);
	});

	it("key-presence refusal: the FIRST keyless stage throws before any batch", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = fauxEngine([]);
		const seen: Array<[string, ModelSlotName]> = [];
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, extractor, auditor: fauxEngine([]),
			providerKeyMissing: (provider, tier) => {
				seen.push([provider, tier]);
				return providerKeyMissing(provider, [tier]);
			},
		});
		await assert.rejects(pipeline.runExtraction(chatId), (err: unknown) => {
			assert.ok(err instanceof ProviderKeyMissingError);
			assert.equal(err.envelope.code, "provider_key_missing");
			assert.equal(err.envelope.provider, extractor.model.provider);
			assert.deepEqual(err.envelope.slots, ["cheap"]);
			return true;
		});
		assert.deepEqual(seen, [[extractor.model.provider, "cheap"]]);
		assert.equal(ledgers.readCoverage().length, 0);
	});

	it("engineFor fills the stages in pipeline order; direct engines win over it", async () => {
		const consulted: string[] = [];
		const viaChain = createExtractionPipeline({
			chatStore, graphStore: memoryLedgers(),
			engineFor: (role) => {
				consulted.push(role);
				return role === "extractor" ? submitModel("submit_findings", FINDINGS) : review();
			},
		});
		assert.equal((await viaChain.runExtraction(fixtureChat().chatId)).nodes, 2);
		assert.deepEqual(consulted.slice(0, 2), ["extractor", "auditor"]);

		const direct = createExtractionPipeline({
			chatStore, graphStore: memoryLedgers(), extractor: submitModel("submit_findings", FINDINGS), auditor: review(),
			engineFor: (role) => {
				throw new Error(`engineFor should not be consulted for ${role} when a direct value is set`);
			},
		});
		assert.equal((await direct.runExtraction(fixtureChat().chatId)).nodes, 2);
	});

	it("a failing stage is ISOLATED: the job fails, nothing merges — and a sibling batch still merges", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		assert.deepEqual(await pipe(ledgers, submitModel("submit_findings", FINDINGS), silentModel()).runExtraction(chatId), { nodes: 0, chains: 0 });
		assert.deepEqual(await pipe(ledgers, silentModel()).runExtraction(chatId), { nodes: 0, chains: 0 });
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readCheckpoints().length, 0);
		assert.equal(ledgers.readCoverage().length, 0, "the next trigger re-runs");

		// Two batches whose SECOND extractor call never submits.
		const { chatId: chunkyId, record } = chunkyChat();
		let invocations = 0;
		const findings = findingsStep();
		const countingStep: FauxResponseStep = (context, options, state, model) => {
			invocations++;
			return invocations === 1 ? findings(context, options, state, model) : fauxAssistantMessage("I refuse to use tools");
		};
		const mixed = createExtractionPipeline({
			chatStore, graphStore: ledgers, getChunkTokens: () => 4096,
			engineFor: (role) => (role === "extractor" ? fauxEngine([countingStep]) : review()),
		});
		assert.deepEqual(await mixed.runExtraction(chunkyId), { nodes: 2, chains: 1 }, "batch 1's merge survives batch 2's failure");
		assert.equal(invocations, 2);
		assert.equal(ledgers.readCoverage().length, 3);
		assert.equal(coverageOf(record.messages, ledgers.readCoverage(), chunkyId).uncoveredCount, 2);
	});

	const single = (id: string, name: string) => ({ propositions: [{ id, name, statement: `${name} statement`, aliases: [], messageId: "a1" }], chains: [] });

	it("serialized audit: a second run QUEUES at the gate; its auditor explores the graph only AFTER the first run's merge", async () => {
		const a = fixtureChat();
		const b = fixtureChat();
		const ledgers = memoryLedgers();
		let gateOpen!: () => void;
		const gate = new Promise<void>((resolve) => (gateOpen = resolve));
		const runA = pipe(ledgers, submitModel("submit_findings", single("pa", "Alpha claim")), gatedSubmitModel("submit_review", { links: [] }, gate)).runExtraction(a.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === a.chatId && r.phase === "auditing"));

		let bAuditorCalled = false;
		let bSawAlphasMerge = false;
		const runB = pipe(ledgers, submitModel("submit_findings", single("pb", "Beta claim")), review(undefined, () => {
			bAuditorCalled = true;
			bSawAlphasMerge = ledgers.readNodes().some((n) => n.name === "Alpha claim");
		})).runExtraction(b.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === b.chatId && r.phase === "waiting"));
		assert.ok(!bAuditorCalled, "B queues behind A");
		assert.equal(ledgers.readNodes().filter((n) => n.name === "Beta claim").length, 0);
		assert.equal(extractionStatuses().find((r) => r.chatId === a.chatId)?.phase, "auditing");

		gateOpen();
		assert.deepEqual(await runA, { nodes: 1, chains: 0 });
		assert.deepEqual(await runB, { nodes: 1, chains: 0 });
		assert.ok(bSawAlphasMerge, "B's auditor saw A's merged node");
		assert.equal(extractionStatuses().length, 0);
	});

	it("serialized audit: a run ABORTED while waiting never audits — and the queue stays healthy for successors", async () => {
		const [a, b, c] = [fixtureChat(), fixtureChat(), fixtureChat()];
		const ledgers = memoryLedgers();
		let gateOpen!: () => void;
		const gate = new Promise<void>((resolve) => (gateOpen = resolve));
		const runA = pipe(ledgers, submitModel("submit_findings", single("pa", "Alpha claim")), gatedSubmitModel("submit_review", { links: [] }, gate)).runExtraction(a.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === a.chatId && r.phase === "auditing"));

		let bAuditorCalled = false;
		const runB = pipe(ledgers, submitModel("submit_findings", single("pb", "Beta claim")), review(undefined, () => {
			bAuditorCalled = true;
		})).runExtraction(b.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === b.chatId && r.phase === "waiting"));
		assert.equal(abortExtraction(b.chatId), true);
		assert.deepEqual(await runB, { nodes: 0, chains: 0 });
		assert.ok(!bAuditorCalled);
		assert.ok(!extractionStatuses().some((r) => r.chatId === b.chatId));
		assert.equal(ledgers.readCoverage().some((row) => row.chatId === b.chatId), false);

		gateOpen();
		assert.deepEqual(await runA, { nodes: 1, chains: 0 });
		assert.deepEqual(await pipe(ledgers, submitModel("submit_findings", single("pc", "Gamma claim"))).runExtraction(c.chatId), { nodes: 1, chains: 0 });
	});

	it("captures per-stage usage live and persists the run's usage into the chat record", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		ledgers.appendNode(seed("n_existing", "Derivative"));
		const usageSeen: (number | undefined)[] = [];
		const nativeUsage: Record<"extractor" | "auditor", Usage[]> = { extractor: [], auditor: [] };
		const recordUsage = (stage: "extractor" | "auditor", engine: PiEngine): PiEngine => ({
			...engine,
			streamFn: (model, context, options) => {
				const stream = engine.streamFn(model, context, options);
				void stream.result().then((message) => nativeUsage[stage].push(message.usage));
				return stream;
			},
		});
		await pipe(
			ledgers,
			recordUsage("extractor", submitModel("submit_findings", FINDINGS)),
			recordUsage("auditor", review({ links: [{ id: "p1", linkTo: "n_existing" }] }, () =>
				usageSeen.push(extractionStatuses().find((r) => r.chatId === chatId)?.usage.extractor?.steps.at(-1)?.inputTokens),
			)),
		).runExtraction(chatId);

		// Live: mid-audit the extractor's usage was already accumulated.
		assert.ok(usageSeen.length === 1 && usageSeen[0]! > 0);
		const record = chatStore.getChat(chatId)!;
		assert.equal(record.extractions?.length, 1);
		const run = record.extractions![0]!;
		assert.equal(run.stats?.nodes, 1);
		assert.equal(run.stages.extractor.model, "faux:faux-1");
		for (const stage of ["extractor", "auditor"] as const) {
			assert.equal(run.stages[stage].steps.length, 1);
			const step = run.stages[stage].steps[0]!;
			const native = nativeUsage[stage][0]!;
			assert.ok(step.inputTokens! > 0 && step.outputTokens! > 0);
			assert.ok(native.cacheWrite > 0, "a fresh native conversation writes its cached prefix");
			assert.equal(step.cacheReadTokens, 0);
			assert.equal(step.cacheReadTokens, native.cacheRead);
			assert.equal(step.cacheWriteTokens, native.cacheWrite);
		}
		assert.ok(!Number.isNaN(Date.parse(run.at)));
	});

	it("aborts mid-run: cancels the model call, persists partial usage, checkpoints nothing", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const runPromise = pipe(ledgers, fauxEngine([hangStep])).runExtraction(chatId);
		// The registry entry exists synchronously; abort is true cancellation.
		assert.equal(abortExtraction(chatId), true);
		assert.deepEqual(await runPromise, { nodes: 0, chains: 0 });
		assert.equal(extractionStatuses().length, 0);
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readCheckpoints().length, 0);
		const run = chatStore.getChat(chatId)!.extractions![0]!;
		assert.equal(chatStore.getChat(chatId)!.extractions!.length, 1, "money was spent: partial usage persists");
		assert.equal(run.stats, undefined);
		assert.equal(run.stages.extractor.steps.length, 0);
		assert.equal(run.stages.auditor.steps.length, 0);
		assert.equal(abortExtraction(chatId), false, "aborting a non-running chat is a no-op");
	});

	it("single-flight spans pipeline instances: a run registered by one is a no-op for another", async () => {
		const { chatId } = fixtureChat();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const gatedExtractor = fauxEngine([async () => {
			if (++calls === 1) await gate;
			return fauxAssistantMessage("…");
		}]);
		const first = pipe(memoryLedgers(), gatedExtractor, silentModel()).runExtraction(chatId);
		assert.ok(extractionStatuses().some((run) => run.chatId === chatId && run.phase === "extracting"), "registered at start");
		assert.deepEqual(await pipe(memoryLedgers(), silentModel(), silentModel()).runExtraction(chatId), { nodes: 0, chains: 0 });
		release();
		assert.deepEqual(await first, { nodes: 0, chains: 0 });
		assert.ok(!extractionStatuses().some((run) => run.chatId === chatId));
	});

	it("throws for unknown chats", async () => {
		await assert.rejects(pipe(memoryLedgers(), silentModel(), silentModel()).runExtraction("chat_does_not_exist"), /Chat not found/);
	});

	it("a chat deleted mid-run aborts at the merge with nothing merged, checkpointed, or billed", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const stats = await pipe(ledgers, submitModel("submit_findings", FINDINGS), review(undefined, () => chatStore.deleteChat(chatId))).runExtraction(chatId);
		assert.equal(stats.nodes, 0);
		assert.equal(stats.chains, 0);
		assert.equal(ledgers.readNodes().length + ledgers.readChains().length + ledgers.readCoverage().length + ledgers.readCheckpoints().length, 0);
		assert.equal(extractionStatuses().some((run) => run.chatId === chatId), false);
		assert.equal(chatStore.getChat(chatId), null);
	});
});

// ─── message anchors ─────────────────────────────────────────────────────────

describe("message anchors (session propositions carry their passage's id)", () => {
	const anchored = (messageId: string) => ({
		propositions: [{ id: "p1", name: "Anchor claim", statement: "Anchor claim, full precision.", aliases: [], messageId }],
		chains: [],
	});
	const submitStep = (payload: unknown): FauxResponseStep => () => toolMessage("submit_findings", payload, "anchor-call");

	it("a submit MISSING messageId never passes: nothing merges, nothing checkpoints", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const bare = { propositions: [{ id: "p1", name: "Anchor claim", statement: "Anchor claim, full precision.", aliases: [] }], chains: [] };
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers,
			engineFor: (role) => (role === "extractor" ? fauxEngine(Array.from({ length: 4 }, () => submitStep(bare))) : review()),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 0, chains: 0 });
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readCoverage().length, 0, "the batch stays re-runnable");
	});

	it("an EMPTY, LEARNER, or UNKNOWN anchor is refused by error-back; the re-anchored retry merges", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = fauxEngine(["", "u1", "made_up", "a2"].map((id) => submitStep(anchored(id))));
		assert.deepEqual(await pipe(ledgers, extractor).runExtraction(chatId), { nodes: 1, chains: 0 });
		assert.deepEqual(ledgers.readNodes()[0]!.provenance, [{ chatId, messageId: "a2" }]);
	});

	it("the boundary is the CURRENT BATCH: a real teacher id from another batch is refused", async () => {
		const { chatId } = chunkyChat();
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, getChunkTokens: () => 4096,
			extractor: fauxEngine(["a5", "a2", "a4"].map((id) => submitStep(anchored(id)))),
			auditor: fauxEngine([passThroughAuditStep(), passThroughAuditStep()]),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 0 });
		assert.deepEqual(ledgers.readNodes().map((n) => n.provenance[0]!.messageId).sort(), ["a2", "a4"]);
		assert.equal(ledgers.readCoverage().length, 5);
	});

	it("the notes door stays anchor-free: a stray messageId never reaches provenance", async () => {
		const ledgers = memoryLedgers();
		const stray = { propositions: [{ ...NOTES_FINDINGS.propositions[0], messageId: "made_up" }], chains: [] };
		assert.deepEqual(await pipe(ledgers, submitModel("submit_findings", stray)).importNotes({ filePath: "/vault/stray-anchor.md", text: NOTES_TEXT }), { nodes: 1, chains: 0 });
		assert.deepEqual(ledgers.readNodes()[0]!.provenance, [{ chatId: ledgers.readSources()[0]!.id, messageId: "" }]);
	});
});

// ─── chains are the deliverable ──────────────────────────────────────────────

describe("chains are the deliverable", () => {
	/** Step 1 submits a schema-valid but law-violating payload, step 2 the clean one. */
	const retryEngine = (bad: unknown, good: unknown) =>
		fauxEngine([() => toolMessage("submit_findings", bad, "findings-bad"), () => toolMessage("submit_findings", good, "findings-good")]);

	it("co-premises ride as ONE stored argument", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = submitModel("submit_findings", {
			propositions: [
				{ id: "p1", name: "A", statement: "A holds.", aliases: [], messageId: "a1" },
				{ id: "p2", name: "B", statement: "B holds.", aliases: [], messageId: "a2" },
				{ id: "p3", name: "C", statement: "A and B together entail C.", aliases: [], messageId: "a1" },
			],
			chains: [{ premises: ["p1", "p2"], conclusion: "p3" }],
		});
		assert.deepEqual(await pipe(ledgers, extractor).runExtraction(chatId), { nodes: 3, chains: 1 });
		const byName = new Map(ledgers.readNodes().map((n) => [n.name, n.id]));
		const chains = ledgers.readChains();
		assert.ok(chains.every((c) => c.conclusion === byName.get("C")));
		assert.deepEqual(chains.flatMap((c) => c.premises).sort(), [byName.get("A")!, byName.get("B")!].sort());
	});

	it("identical chains dedupe silently at the expansion", async () => {
		const extractor = submitModel("submit_findings", { ...FINDINGS, chains: [FINDINGS.chains[0]!, FINDINGS.chains[0]!] });
		assert.deepEqual(await pipe(memoryLedgers(), extractor).runExtraction(fixtureChat().chatId), { nodes: 2, chains: 1 });
	});

	for (const [label, chains] of [
		["a chain referencing an UNKNOWN id", [{ premises: ["p1", "p9"], conclusion: "p2" }]],
		["a conclusion in its OWN premises", [{ premises: ["p1", "p2"], conclusion: "p2" }]],
		["empty premises", [{ premises: [], conclusion: "p2" }]],
	] as const) {
		it(`validate error-back: ${label} is rejected, the model re-submits clean`, async () => {
			const extractor = retryEngine({ ...FINDINGS, chains }, FINDINGS);
			assert.deepEqual(await pipe(memoryLedgers(), extractor).runExtraction(fixtureChat().chatId), { nodes: 2, chains: 1 });
		});
	}

	it("sessions and notes each route to their own extractor instructions", async () => {
		const seen: string[] = [];
		const capturing = (input: unknown) => fauxEngine([(context) => {
			seen.push(systemPromptOf(context));
			return toolMessage("submit_findings", input);
		}]);
		assert.deepEqual(await pipe(memoryLedgers(), capturing(FINDINGS)).runExtraction(fixtureChat().chatId), { nodes: 2, chains: 1 });
		const sketch = {
			propositions: [
				{ id: "p1", name: "Inner-product spaces are normed", statement: "Every inner-product space is a normed space.", aliases: [] },
				{ id: "p2", name: "Normed spaces are metric", statement: "Every normed space is a metric space.", aliases: [] },
				{ id: "p3", name: "Inner-product spaces are metric", statement: "Every inner-product space is a metric space.", aliases: [] },
			],
			chains: [{ premises: ["p1", "p2"], conclusion: "p3" }],
		};
		assert.deepEqual(await pipe(memoryLedgers(), capturing(sketch)).importNotes({ filePath: "synthetic-sketch.txt", text: "Inner-product ⊂ normed ⊂ metric." }), { nodes: 3, chains: 1 });
		assert.deepEqual(seen, [EXTRACTOR_INSTRUCTIONS, NOTES_EXTRACTOR_INSTRUCTIONS]);
	});
});

// ─── the notes front door ────────────────────────────────────────────────────

describe("the notes front door (importNotes)", () => {
	it("imports raw notes end to end: notes run, source record, file-scoped provenance", async () => {
		const ledgers = memoryLedgers();
		const seen: { kind?: string; label?: string }[] = [];
		const auditor = submitModel("submit_review", NOTES_VERDICT, () => {
			const run = extractionStatuses().find((r) => r.chatId.startsWith("src_"));
			seen.push({ kind: run?.kind, label: run?.label });
		});
		const stats = await pipe(ledgers, submitModel("submit_findings", NOTES_FINDINGS), auditor).importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });
		assert.deepEqual(stats, { nodes: 1, chains: 0 });
		assert.deepEqual(seen, [{ kind: "notes", label: "/vault/learn vim.md" }]);
		assert.equal(extractionStatuses().length, 0);

		const source = ledgers.readSources()[0]!;
		assert.match(source.id, /^src_/);
		assert.equal(source.filePath, "/vault/learn vim.md");
		assert.ok(Date.parse(source.importedAt));
		assert.equal(source.extractions?.length, 1);
		assert.equal(source.extractions![0]!.stats?.nodes, 1);
		assert.ok(source.extractions![0]!.stages.extractor.steps.length > 0);
		assert.deepEqual(ledgers.readNodes()[0]!.provenance, [{ chatId: source.id, messageId: "" }]);
		assert.equal(ledgers.readCheckpoints()[0]!.chatId, source.id);
	});

	it("chunks a large file: one extract→audit→merge per chunk, part headers in each view", async () => {
		const ledgers = memoryLedgers();
		const views: string[] = [];
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, getChunkTokens: () => 20,
			engineFor: (role) => (role === "extractor"
				? fauxEngine([(context) => {
					views.push(capturedView(context));
					return toolMessage("submit_findings", NOTES_FINDINGS, `findings-${views.length}`);
				}])
				: review()),
		});
		const stats = await pipeline.importNotes({ filePath: "/vault/big.md", text: Array.from({ length: 8 }, (_, i) => `note line ${i}: ${"x".repeat(30)}`).join("\n") });
		const calls = views.length;
		assert.ok(calls >= 2);
		assert.match(views[0]!, new RegExp(`part 1/${calls}`));
		assert.match(views.at(-1)!, new RegExp(`part ${calls}/${calls}`));
		// Jobs merge independently; cross-chunk identity is the auditor's.
		assert.deepEqual(stats, { nodes: calls, chains: 0 });
	});

	it("every explicit import runs the whole file, even identical text and legacy fingerprints", async () => {
		const ledgers = memoryLedgers();
		const run = (text = NOTES_TEXT) => pipe(ledgers, submitModel("submit_findings", NOTES_FINDINGS), review(NOTES_VERDICT)).importNotes({ filePath: "/vault/learn vim.md", text });
		assert.deepEqual(await run(), { nodes: 1, chains: 0 });
		ledgers.upsertSource({ ...ledgers.readSources()[0]!, contentFp: createHash("sha256").update(NOTES_TEXT).digest("hex").slice(0, 16) });
		assert.deepEqual(await run(), { nodes: 1, chains: 0 }, "a legacy stamp never suppresses an explicit import");
		assert.equal(ledgers.readSources()[0]!.contentFp, undefined, "new imports write no fingerprint");
		assert.deepEqual(await run(`${NOTES_TEXT}\nA new closing line.`), { nodes: 1, chains: 0 });
		assert.equal(ledgers.readSources().length, 1, "the path hashes to one source identity");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 3, "every run bills usage");
		assert.equal(ledgers.readNodes().length, 3, "the auditor, not a content skip, owns identity");
	});

	it("aborts like a chat run: nothing merged, partial usage in the source record", async () => {
		const ledgers = memoryLedgers();
		const runPromise = pipe(ledgers, fauxEngine([hangStep]), review(NOTES_VERDICT)).importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });
		assert.equal(abortExtraction(extractionStatuses().find((r) => r.chatId.startsWith("src_"))!.chatId), true);
		await assert.rejects(runPromise, (error) => error instanceof NotesImportError && error.outcome === "aborted" && error.partialStats.nodes === 0);
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readCheckpoints().length, 0);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 1);
		assert.equal(ledgers.readSources()[0]!.extractions![0]!.stats, undefined);
	});

	it("one job per chunk, SERIALIZED per source: one live row at a time, and a source-wide abort ends the run", async () => {
		const ledgers = memoryLedgers();
		const abortingStep: FauxResponseStep = (_context, options) =>
			new Promise((_resolve, reject) => {
				const die = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				if (options?.signal?.aborted) die();
				else options?.signal?.addEventListener("abort", die, { once: true });
			});
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, getChunkTokens: () => 20,
			engineFor: (role) => (role === "extractor" ? fauxEngine([abortingStep]) : review()),
		});
		const runPromise = pipeline.importNotes({ filePath: "/vault/parallel.md", text: Array.from({ length: 8 }, (_, i) => `note ${i}: ${"x".repeat(90)}`).join("\n") });
		const srcId = extractionStatuses().find((r) => r.chatId.startsWith("src_"))!.chatId;
		await until(() => extractionStatuses().some((r) => r.chatId === srcId && r.phase === "extracting"), 500);
		const rows = extractionStatuses().filter((r) => r.chatId === srcId);
		assert.equal(rows.length, 1);
		assert.deepEqual(rows[0]!.part, { i: 1, n: 8 });

		assert.equal(abortExtraction(srcId), true);
		await assert.rejects(runPromise, (error) => error instanceof NotesImportError && error.outcome === "aborted");
		assert.equal(extractionStatuses().filter((r) => r.chatId === srcId).length, 0);
		assert.equal(ledgers.readNodes().length, 0);
		const source = ledgers.readSources().find((src) => src.id === srcId)!;
		assert.equal(source.extractions?.length, 1, "only the aborted job bills — later chunks never ran");
		assert.equal(source.extractions![0]!.stats, undefined);
	});
});

// ─── extraction coverage (the chunked chat pipeline) ─────────────────────────

describe("the chunked pipeline (extraction coverage)", () => {
	it("extracts uncovered messages in token-budgeted batches, checkpoints coverage per batch, and no-ops once covered", async () => {
		const { chatId, record } = chunkyChat();
		const ledgers = memoryLedgers();
		const views: string[] = [];
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, getChunkTokens: () => 4096,
			extractor: fauxEngine([findingsStep((v) => views.push(v)), findingsStep((v) => views.push(v))]),
			auditor: fauxEngine([passThroughAuditStep(), passThroughAuditStep()]),
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.equal(views.length, 2);
		assert.ok(views[0]!.includes("topic 1:") && views[0]!.includes("topic 3:") && !views[0]!.includes("topic 4:"));
		assert.ok(views[1]!.includes("topic 4:") && views[1]!.includes("topic 5:") && !views[1]!.includes("topic 3:"));
		// Batch 2's identical ids are a separate job's namespace: fresh nodes.
		assert.deepEqual(stats, { nodes: 4, chains: 2 });
		assert.equal(ledgers.readCoverage().length, record.messages.length);
		assert.equal(coverageOf(record.messages, ledgers.readCoverage(), chatId).uncoveredCount, 0);

		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 0, chains: 0 });
		assert.equal(views.length, 2, "no model calls on covered ground");
		assert.equal(chatStore.getChat(chatId)!.extractions?.length, 2, "one usage record per batch job; the no-op persists none");
	});

	it("aborting after a merged batch keeps it covered; the re-run extracts only the remainder", async () => {
		const { chatId, record } = chunkyChat();
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, getChunkTokens: () => 4096,
			extractor: fauxEngine([findingsStep(), hangStep]),
			auditor: fauxEngine([passThroughAuditStep()]),
		});
		const runPromise = pipeline.runExtraction(chatId);
		await until(() => ledgers.readCoverage().length > 0);
		assert.equal(abortExtraction(chatId), true);
		assert.deepEqual(await runPromise, { nodes: 2, chains: 1 });
		assert.equal(ledgers.readCoverage().length, 3);
		assert.equal(coverageOf(record.messages, ledgers.readCoverage(), chatId).uncoveredCount, 2);

		const reRunViews: string[] = [];
		await pipe(ledgers, fauxEngine([findingsStep((v) => reRunViews.push(v))]), fauxEngine([passThroughAuditStep()])).runExtraction(chatId);
		assert.equal(reRunViews.length, 1);
		assert.ok(reRunViews[0]!.includes("topic 4:") && reRunViews[0]!.includes("topic 5:") && !reRunViews[0]!.includes("topic 1:"));
		assert.equal(ledgers.readCoverage().length, 5);
	});

	it("a re-opened message re-extracts alone; a data-part attach never re-opens it", async () => {
		const chat = chatStore.createChat("Re-open fixture");
		createdChats.push(chat.id);
		const chatId = chat.id;
		chatStore.saveMessages(chatId, [
			...assistant("s1", [{ type: "text", text: "short topic one" }]),
			...assistant("s2", [{ type: "text", text: "short topic two" }]),
		]);
		const ledgers = memoryLedgers();
		const messages = () => chatStore.getChat(chatId)!.messages;
		const uncovered = () => coverageOf(messages(), ledgers.readCoverage(), chatId).uncoveredCount;
		await pipe(ledgers, fauxEngine([findingsStep()]), fauxEngine([passThroughAuditStep()])).runExtraction(chatId);
		assert.equal(uncovered(), 0);

		chatStore.saveMessages(chatId, [
			...messages(),
			newPlanBlockMessage("call_s2", { kind: "full", at: "2026-09-26T00:00:00.000Z", current: null, nodes: [], edges: [] }),
		]);
		assert.equal(uncovered(), 0, "data parts don't change the fingerprint");

		chatStore.saveMessages(chatId, messages().map((m) =>
			(m as { id?: string }).id === "s1"
				? ({ ...m, content: [...(m as { content: unknown[] }).content, { type: "text", text: "the answer merged in late" }] } as never)
				: m,
		));
		assert.equal(uncovered(), 1, "only the mutated message re-opens");

		const reRunViews: string[] = [];
		await pipe(ledgers, fauxEngine([findingsStep((v) => reRunViews.push(v))]), fauxEngine([passThroughAuditStep()])).runExtraction(chatId);
		assert.equal(reRunViews.length, 1);
		assert.ok(reRunViews[0]!.includes("short topic one") && reRunViews[0]!.includes("the answer merged in late") && !reRunViews[0]!.includes("short topic two"));
		assert.equal(uncovered(), 0);
	});
});

// ─── digest-aware serialized extraction ─────────────────────────────────────

describe("digest-aware serialized extraction (the extractor is the assembler)", () => {
	it("sourceDigest renders the same-source truth (ids verbatim) and stays empty for a barren source", () => {
		const graph = {
			nodes: [seed("n_a", "Self-ownership", [{ chatId: "src_1", messageId: "" }]), seed("n_x", "Foreign key", [{ chatId: "src_2", messageId: "" }])],
			chains: [{ id: "arg_1", premises: ["n_a"], conclusion: "n_x", createdAt: "2026-09-30T00:00:01.000Z", provenance: [{ chatId: "src_2", messageId: "" }] }],
			sessions: {},
			sources: {},
		} as unknown as Parameters<typeof sourceDigest>[0];
		assert.equal(sourceDigest(graph, "src_9"), "");
		const digest = sourceDigest(graph, "src_1");
		assert.match(digest, /THE GRAPH SO FAR/);
		assert.match(digest, /n_a \| Self-ownership \| statement of Self-ownership/);
		assert.doesNotMatch(digest, /Foreign key/, "other sources' material never leaks into the digest");
		assert.doesNotMatch(digest, /DERIVATIONS ALREADY RECORDED/);
	});

	it("the auditor starts with candidates and the batched find_candidates tool; its link merges", async () => {
		const ledgers = memoryLedgers();
		ledgers.appendNode(seed("n_seed", "Evaporation", [{ chatId: "old_source", messageId: "" }], "Liquid changes into vapor."));
		const auditor = fauxEngine([
			(context) => {
				const system = context.messages.find((message) => message.role === "system");
				assert.ok(system && system.role === "system");
				assert.ok(system.toolsAdded?.some((tool) => tool.name === "find_candidates"));
				assert.ok(!system.toolsAdded?.some((tool) => tool.name === "find"));
				const view = capturedView(context);
				const initial = JSON.parse(view.slice(view.indexOf("{")));
				assert.deepEqual(initial.matches[0].candidateIds, ["n_seed"]);
				assert.equal(initial.candidates[0].statement, "Liquid changes into vapor.");
				return toolMessage("find_candidates", { propositions: [{ id: "p1" }] }, "lookup");
			},
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				assert.ok(result && result.role === "toolResult");
				const text = result.content.find((part) => part.type === "text");
				assert.ok(text && text.type === "text");
				assert.deepEqual(JSON.parse(text.text).matches[0].candidateIds, ["n_seed"]);
				return toolMessage("submit_review", { links: [{ id: "p1", linkTo: "n_seed" }] }, "review");
			},
		]);
		const extractor = submitModel("submit_findings", { propositions: [{ id: "p1", name: "Vaporization", statement: "Liquid changes into vapor.", aliases: [] }], chains: [] });
		const stats = await pipe(ledgers, extractor, auditor).importNotes({ filePath: "synthetic-candidates.txt", text: "Liquid changes into vapor." });
		assert.equal(stats.nodes, 0);
		assert.equal(getGraph(ledgers).nodes.length, 1);
		assert.ok(getGraph(ledgers).nodes[0]!.provenance.some((point) => point.chatId === ledgers.readSources()[0]!.id));
	});

	it("a supplied accepted alias is matched in one auditor response; the source passage never reaches the auditor", async () => {
		const ledgers = memoryLedgers();
		ledgers.appendNode({ ...seed("n_seed", "Legacy label", [{ chatId: "old_source", messageId: "" }]), aliases: ["An amber canoe travels upstream."] });
		let calls = 0;
		const auditor = fauxEngine([(context) => {
			calls++;
			const view = capturedView(context);
			assert.deepEqual(JSON.parse(view.slice(view.indexOf("{"))).candidates[0].matchedAliases, ["An amber canoe travels upstream."]);
			assert.doesNotMatch(view, /PRIVATE SOURCE PASSAGE/);
			return toolMessage("submit_review", { links: [{ id: "p1", linkTo: "n_seed" }] }, "review");
		}]);
		const extractor = submitModel("submit_findings", { propositions: [{ id: "p1", name: "Upstream travel", statement: "An amber canoe travels upstream.", aliases: [] }], chains: [] });
		const stats = await pipe(ledgers, extractor, auditor).importNotes({ filePath: "synthetic-alias.txt", text: "PRIVATE SOURCE PASSAGE" });
		assert.equal(calls, 1);
		assert.equal(stats.nodes, 0);
		assert.equal(getGraph(ledgers).nodes.length, 1);
	});

	it("a seeded digest rides the extractor's view: mixed-namespace chains reference existing ids VERBATIM", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		ledgers.appendNode(seed("n_a", "Self-ownership", [{ chatId, messageId: "m0" }]));
		const views: string[] = [];
		const extractor = fauxEngine([(context) => {
			views.push(capturedView(context));
			return toolMessage("submit_findings", {
				propositions: [
					{ id: "p1", name: "Appropriation axiom", statement: "c", aliases: [], messageId: "a1" },
					{ id: "p1b", name: "Property rights", statement: "d", aliases: [], messageId: "a2" },
				],
				chains: [{ premises: ["n_a", "p1"], conclusion: "p1b" }],
			});
		}]);
		const stats = await pipe(ledgers, extractor).runExtraction(chatId);
		assert.match(views[0]!, /THE GRAPH SO FAR/);
		assert.match(views[0]!, /n_a \| Self-ownership/);
		assert.deepEqual(stats, { nodes: 2, chains: 1 });
		const stored = ledgers.readChains();
		const byName = new Map(ledgers.readNodes().map((n) => [n.name, n.id]));
		assert.equal(stored.length, 1);
		assert.deepEqual(stored[0]!.premises, ["n_a", byName.get("Appropriation axiom")]);
		assert.equal(stored[0]!.conclusion, byName.get("Property rights"));
	});

	it("batches serialize: chunk 2's extractor starts only after chunk 1's audit ran", async () => {
		const { chatId } = chunkyChat();
		const events: string[] = [];
		const findings = findingsStep();
		const extractStep: FauxResponseFactory = (...args) => {
			events.push("extract");
			return findings(...args);
		};
		const auditStep: FauxResponseFactory = () => {
			events.push("audit");
			return toolMessage("submit_review", { links: [] });
		};
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: memoryLedgers(), getChunkTokens: () => 4096,
			extractor: fauxEngine([extractStep, extractStep]),
			auditor: fauxEngine([auditStep, auditStep]),
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.deepEqual(events, ["extract", "audit", "extract", "audit"]);
		assert.equal(stats.nodes, 4);
	});
});

// ─── chain simplification ────────────────────────────────────────────────────

describe("chain simplification (the merger's maintenance pass)", () => {
	const chain = (id: string, premises: string[], conclusion: string, hour: number, chatId = "src_1"): GraphChain =>
		({ id, premises, conclusion, createdAt: `2026-09-30T0${hour}:00:00.000Z`, provenance: [{ chatId, messageId: "" }] });

	for (const [label, chains, expected] of [
		["[A,B]⇒X + [X,C]⇒Y make [A,B,C]⇒Y redundant (ancestry-cover)",
			[chain("arg_3", ["n_a", "n_b", "n_c"], "n_y", 3), chain("arg_1", ["n_a", "n_b"], "n_x", 1), chain("arg_2", ["n_x", "n_c"], "n_y", 2)],
			["arg_1", "arg_2"]],
		["different routes to one conclusion stand; a premise-superset route yields to the lean one",
			[chain("arg_1", ["n_a"], "n_y", 1), chain("arg_2", ["n_b"], "n_y", 2), chain("arg_3", ["n_c", "n_d"], "n_y", 3), chain("arg_4", ["n_a", "n_c"], "n_y", 4)],
			["arg_1", "arg_2", "arg_3"]],
		["ancestry reaches transitively: [W]⇒A chains through [A,B]⇒X",
			[chain("arg_1", ["n_w"], "n_a", 1), chain("arg_2", ["n_a", "n_b"], "n_x", 2), chain("arg_3", ["n_x", "n_c"], "n_y", 3), chain("arg_4", ["n_w", "n_b", "n_c"], "n_y", 4)],
			["arg_1", "arg_2", "arg_3"]],
		["same-key provenance lines drop TOGETHER",
			[chain("arg_1", ["n_a"], "n_z", 1), chain("arg_1", ["n_a"], "n_z", 1, "src_2"), chain("arg_2", ["n_a", "n_b"], "n_z", 2), chain("arg_2", ["n_a", "n_b"], "n_z", 2, "src_2")],
			["arg_1", "arg_1"]],
	] as const) {
		it(label, () => {
			assert.deepEqual(simplifyChains([...chains]).map((c) => c.id).sort(), [...expected]);
		});
	}

	it("the merge applies it live: a redundant arrival is appended then dropped", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		for (const id of ["n_a", "n_b", "n_c", "n_x", "n_y"]) ledgers.appendNode(seed(id, id, [{ chatId, messageId: "m0" }]));
		ledgers.appendChain(chain("arg_1", ["n_a", "n_b"], "n_x", 1));
		ledgers.appendChain(chain("arg_2", ["n_x", "n_c"], "n_y", 2));
		const redundant: SessionFindings = { propositions: [], chains: [{ premises: ["n_a", "n_b", "n_c"], conclusion: "n_y" }] };
		const stats = await pipe(ledgers, submitModel("submit_findings", redundant)).runExtraction(chatId);
		assert.equal(stats.chains, 1);
		assert.equal(stats.droppedChains, 1);
		assert.equal(ledgers.readChains().length, 2, "the ledger is back to the two lean chains");
	});
});

// ─── notes import completion and retry reliability ──────────────────────────

describe("notes import completion and retry reliability", () => {
	const input = { filePath: "reliability.md", text: NOTES_TEXT };
	const threeChunks = { ...input, text: "first chunk\nsecond chunk\nthird chunk" };
	const make = (graphStore: GraphStore, extractor = submitModel("submit_findings", NOTES_FINDINGS)) => pipe(graphStore, extractor, review(NOTES_VERDICT));
	const chunked = (graphStore: GraphStore, extractor: () => PiEngine) =>
		createExtractionPipeline({ chatStore, graphStore, getChunkTokens: () => 1, engineFor: (role) => (role === "auditor" ? review(NOTES_VERDICT) : extractor()) });
	const incomplete = (outcome: NotesImportError["outcome"], nodes: number, message?: RegExp) => (error: unknown) => {
		assert.ok(error instanceof NotesImportError);
		assert.equal(error.outcome, outcome);
		assert.equal(error.partialStats.nodes, nodes);
		if (message) assert.match(error.message, message);
		return true;
	};

	it("failure followed by an unchanged retry really extracts and preserves both usage records", async () => {
		const ledgers = memoryLedgers();
		await assert.rejects(make(ledgers, silentModel()).importNotes(input), incomplete("failed", 0));
		assert.deepEqual(await make(ledgers).importNotes(input), { nodes: 1, chains: 0 });
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	it("zero new nodes and an empty file are successful, but the readiness gate still applies", async () => {
		const ledgers = memoryLedgers();
		assert.deepEqual(await make(ledgers, submitModel("submit_findings", { propositions: [], chains: [] })).importNotes(input), { nodes: 0, chains: 0 });
		assert.deepEqual(await make(ledgers).importNotes({ ...input, text: " \n" }), { nodes: 0, chains: 0 });
		await assert.rejects(createExtractionPipeline({ chatStore, graphStore: ledgers }).importNotes({ ...input, text: "" }), ModelsNotConfiguredError);
		await assert.rejects(createExtractionPipeline({ chatStore, graphStore: ledgers, extractor: submitModel("submit_findings", NOTES_FINDINGS), auditor: review(NOTES_VERDICT), providerKeyMissing: () => providerKeyMissing("openai", ["cheap"]) }).importNotes(input), ProviderKeyMissingError);
	});

	it("isolates an ordinary failed chunk, reports partial, and keeps earlier/later merges and usage", async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		await assert.rejects(chunked(ledgers, () => fauxEngine([() => {
			if (++calls === 2) throw new Error("synthetic failed chunk");
			return toolMessage("submit_findings", NOTES_FINDINGS);
		}])).importNotes(threeChunks), incomplete("partial", 2));
		assert.equal(calls, 3);
		assert.equal(ledgers.readNodes().length, 2);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 3);
	});

	it("an abort after an earlier merge stops later chunks without losing graph or billed usage", async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		await assert.rejects(chunked(ledgers, () => submitModel("submit_findings", NOTES_FINDINGS, () => {
			if (++calls === 2) abortExtraction(ledgers.readSources()[0]!.id);
		})).importNotes(threeChunks), incomplete("aborted", 1));
		assert.equal(calls, 2);
		assert.equal(ledgers.readNodes().length, 1);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	for (const abortAt of [1, 2]) it(`abort in chunk ${abortAt} survives a usage-persistence error and stops later chunks`, async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		let cancelled = false;
		let usageFailures = 0;
		const graphStore: GraphStore = { ...ledgers, appendSourceUsage: (id, entry) => {
			if (cancelled) { usageFailures++; throw new Error("synthetic usage persistence failure during abort"); }
			ledgers.appendSourceUsage(id, entry);
		} };
		await assert.rejects(chunked(graphStore, () => submitModel("submit_findings", NOTES_FINDINGS, () => {
			if (++calls === abortAt) {
				cancelled = true;
				assert.equal(abortExtraction(ledgers.readSources()[0]!.id), true);
			}
		})).importNotes(threeChunks), incomplete("aborted", abortAt - 1, /synthetic usage persistence failure during abort/));
		assert.equal(calls, abortAt, "no later extractor runs after cancellation");
		assert.equal(usageFailures, 1);
		assert.equal(ledgers.readNodes().length, abortAt - 1, "earlier graph merges retained");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, abortAt - 1, "earlier usage retained");
		assert.equal(extractionStatuses().length, 0);
		assert.deepEqual(await make(ledgers).importNotes(threeChunks), { nodes: 1, chains: 0 }, "source exclusion released for a retry");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, abortAt);
	});

	it("a usage-persistence error without an aborted signal remains an isolated failure and later chunks run", async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		const graphStore: GraphStore = { ...ledgers, appendSourceUsage: (id, entry) => {
			if (calls === 1) throw new Error("synthetic isolated usage failure");
			ledgers.appendSourceUsage(id, entry);
		} };
		await assert.rejects(chunked(graphStore, () => submitModel("submit_findings", NOTES_FINDINGS, () => { calls++; })).importNotes(threeChunks),
			incomplete("partial", 3, /synthetic isolated usage failure/));
		assert.equal(calls, 3, "ordinary cleanup failure does not imply cancellation");
		assert.equal(ledgers.readNodes().length, 3);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	it("overlapping identical or different contents are busy BEFORE source metadata changes, across pipeline instances", async () => {
		const ledgers = memoryLedgers();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let upserts = 0;
		const tracked = { ...ledgers, upsertSource: (source: NotesSource) => { upserts++; ledgers.upsertSource(source); } };
		const first = make(tracked, gatedSubmitModel("submit_findings", NOTES_FINDINGS, gate)).importNotes(input);
		const sourceBefore = structuredClone(ledgers.readSources());
		try {
			await assert.rejects(make(tracked).importNotes(input), incomplete("busy", 0));
			await assert.rejects(make(tracked).importNotes({ ...input, text: "changed" }), incomplete("busy", 0));
			assert.equal(upserts, 1, "busy calls cannot even attempt source metadata writes");
			assert.deepEqual(ledgers.readSources(), sourceBefore);
		} finally { release(); }
		await first;
		assert.deepEqual(await make(ledgers).importNotes(input), { nodes: 1, chains: 0 }, "lock released after lifecycle");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	it("a merger failure after a node append is incomplete without rolling back that write", async () => {
		const ledgers = memoryLedgers();
		const broken = { ...ledgers, appendCheckpoint: () => { throw new Error("synthetic checkpoint failure after node append"); } };
		await assert.rejects(make(broken).importNotes(input), incomplete("failed", 0));
		assert.equal(ledgers.readNodes().length, 1);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 1);
	});

	it("a post-merge usage failure is not false success and reports committed stats", async () => {
		const ledgers = memoryLedgers();
		const originalUsage = ledgers.appendSourceUsage;
		let failed = false;
		const broken: GraphStore = { ...ledgers,
			appendSourceUsage: (id, entry) => { if (!failed) { failed = true; throw new Error("synthetic usage failure"); } originalUsage(id, entry); },
		};
		await assert.rejects(make(broken).importNotes(input), incomplete("failed", 1));
		assert.equal(ledgers.readNodes().length, 1);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 1);
		await make(ledgers).importNotes(input);
	});

	it("source-upsert failure is typed and releases exclusion for retry", async () => {
		const ledgers = memoryLedgers();
		await assert.rejects(make({ ...ledgers, upsertSource: () => { throw new Error("synthetic metadata failure"); } }).importNotes(input), incomplete("failed", 0));
		await make(ledgers).importNotes(input);
	});

	for (const filePath of ["1.md", "1.1.md", "1 notes.md", "1.1 notes.md"]) it(`imports and repeats identical text for ${filePath}`, async () => {
		const ledgers = memoryLedgers();
		await make(ledgers).importNotes({ ...input, filePath });
		await make(ledgers).importNotes({ ...input, filePath });
		assert.equal(ledgers.readSources().length, 1);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
		assert.equal(ledgers.readNodes().length, 2);
	});
});
