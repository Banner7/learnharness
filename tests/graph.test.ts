/**
 * Graph merger + deletion + coverage + derivation tests. The merger applies
 * AUDITED VERDICTS: identity is the auditor's linkTo, never string matching.
 *
 * PATHS is fixed at import time, so the data/graph ledgers are backed up and
 * cleared before the suite and restored after.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import type { GraphChain, GraphNode, SessionFindings } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { deriveView, getGraph, graphSnapshot, mergeFindings, type GraphDeps } from "../src/core/graph.ts";
import { coverageSlots } from "../src/core/coverage.ts";
import { deleteChatTraces, deleteNodeTraces, type ChatDeletionStats } from "../src/core/graph-deletion.ts";
import { deleteChatSession, sessionCoverage } from "../src/server/chats.ts";
import { rememberTurnFailure, settledTurnResponse } from "../src/server/turn-runs.ts";
import { beginTurn, endTurn } from "../src/server/turn-liveness.ts";
import { deleteGraphNode, graphRevision } from "../src/server/graph.ts";
import { graphStore } from "../src/store/graph.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { LEDGER_FILES, PATHS, SOURCES_FILE } from "../config.ts";

/** The wired fs adapters, exactly what src/server/stores.ts passes in production. */
const graphDeps = { chatStore, graphStore } as const satisfies GraphDeps;

/** The session merge source for a chat — the fold stamp only. */
const sessionSource = (chatId: string) => ({ foldedAt: chatStore.getChat(chatId)!.updatedAt });

const LEDGER_PATHS = [...Object.values(LEDGER_FILES), SOURCES_FILE];
const backups: Array<{ file: string; bak: string }> = [];
const createdChats: string[] = [];

fs.mkdirSync(PATHS.graph, { recursive: true });
for (const file of LEDGER_PATHS) {
	if (fs.existsSync(file)) {
		const bak = `${file}.w5test.bak`;
		fs.renameSync(file, bak);
		backups.push({ file, bak });
	}
}

after(() => {
	for (const file of LEDGER_PATHS) fs.rmSync(file, { force: true });
	for (const { file, bak } of backups) fs.renameSync(bak, file);
	for (const id of createdChats) fs.rmSync(`${PATHS.chats}/${id}.json`, { force: true });
});

const user = (id: string, text: string): LhMessage => ({ id, role: "user", content: text, timestamp: Date.now() }) as never;
/** A teacher-prose message (the coverage unit, owner 2026-09-28). */
const teacher = (id: string, text: string): LhMessage => ({ id, role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() }) as never;

function fixtureChat(title: string, messages: LhMessage[] = [user("u1", title)]) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, messages);
	return chatStore.getChat(chat.id)!;
}

function oneProp(id: string, name: string, statement: string, extra: { aliases?: string[]; messageId?: string } = {}): SessionFindings {
	return { propositions: [{ id, name, statement, aliases: extra.aliases ?? [], ...(extra.messageId ? { messageId: extra.messageId } : {}) }], chains: [] };
}

const merge = (chatId: string, findings: SessionFindings, links: Array<{ id: string; linkTo: string }> = []) =>
	mergeFindings(chatId, findings, { links }, graphDeps, sessionSource(chatId));

/** The chat the first merger tests fold (shared, so ordering is intentional). */
const chat1 = fixtureChat("Graph fixture");

/** Everything the graph holds for a set of chats — scope, never assume. */
function scopedGraph(chatIds: string[]) {
	const graph = getGraph(graphStore);
	return {
		nodes: graph.nodes.filter((n) => n.provenance.some((pt) => chatIds.includes(pt.chatId))),
		chains: graph.chains.filter((c) => c.provenance.some((pt) => chatIds.includes(pt.chatId))),
	};
}

const noTempFiles = () => assert.equal(fs.readdirSync(PATHS.graph).filter((f) => f.includes(".tmp-")).length, 0, "atomic rewrites left no temp files");

describe("the merger (mergeFindings)", () => {
	it("creates nodes from the verdicts with chat-level provenance", () => {
		const findings: SessionFindings = {
			propositions: [
				{ id: "p1", name: "Alpha", statement: "Alpha intuition", aliases: ["alpha feel"] },
				{ id: "p2", name: "Beta rule", statement: "Beta rule", aliases: [] },
				{ id: "p3", name: "Gamma", statement: "Gamma application", aliases: [] },
			],
			chains: [{ premises: ["p1"], conclusion: "p2" }],
		};
		assert.deepEqual(merge(chat1.id, findings), { nodes: 3, chains: 1 });

		const graph = scopedGraph([chat1.id]);
		assert.equal(graph.nodes.length, 3);
		const idByStatement = new Map(graph.nodes.map((n) => [n.statement, n.id]));
		const alpha = graph.nodes.find((n) => n.statement === "Alpha intuition")!;
		assert.match(alpha.id, /^n_/);
		assert.deepEqual(alpha.provenance, [{ chatId: chat1.id, messageId: "" }]);

		assert.equal(graph.chains.length, 1);
		const chain = graph.chains[0]!;
		assert.match(chain.id, /^arg_/);
		assert.deepEqual(chain.premises, [idByStatement.get("Alpha intuition")]);
		assert.equal(chain.conclusion, idByStatement.get("Beta rule"));
		assert.deepEqual(chain.provenance, [{ chatId: chat1.id, messageId: "" }]);
	});

	it("applies a linkTo verdict: phrasings join aliases, provenance unions, no duplicate node; the snapshot indexes both sessions", () => {
		const alphaId = scopedGraph([chat1.id]).nodes.find((n) => n.statement === "Alpha intuition")!.id;
		const chat2 = fixtureChat("Graph fixture 2");
		assert.deepEqual(merge(chat2.id, oneProp("q1", "Alpha", "Alpha feel", { aliases: ["alpha intuition"] }), [{ id: "q1", linkTo: alphaId }]), { nodes: 0, chains: 0 });

		assert.equal(scopedGraph([chat1.id, chat2.id]).nodes.length, 3, "no duplicate node");
		const alpha = getGraph(graphStore).nodes.find((n) => n.id === alphaId)!;
		assert.ok(alpha.aliases.includes("Alpha feel") && alpha.aliases.includes("alpha intuition"));
		assert.ok(alpha.provenance.some((pt) => pt.chatId === chat2.id));

		const snap = graphSnapshot(graphDeps);
		assert.equal(snap.sessions[chat1.id], "Graph fixture");
		assert.equal(snap.sessions[chat2.id], "Graph fixture 2");
		assert.deepEqual([...(snap.nodeSessions[alphaId] ?? [])].sort(), [chat1.id, chat2.id].sort());
		const gammaId = snap.nodes.find((n) => n.statement === "Gamma application")!.id;
		assert.deepEqual(snap.nodeSessions[gammaId], [chat1.id]);
	});

	it("never string-matches without a verdict — an identical statement without linkTo is a NEW node", () => {
		const chat3 = fixtureChat("Graph fixture 3");
		assert.equal(merge(chat3.id, oneProp("r1", "Alpha", "Alpha intuition")).nodes, 1);
		assert.equal(getGraph(graphStore).nodes.filter((n) => n.statement === "Alpha intuition").length, 2);
	});

	it("messageId anchors (2026-10-13): creates AND link-appends stamp the passage id; chains stay chat-level", () => {
		const chat = fixtureChat("Anchor fixture", [user("u1", "teach anchors"), teacher("t1", "First."), teacher("t2", "Second.")]);
		assert.equal(merge(chat.id, oneProp("p1", "Anchored", "Anchored statement", { messageId: "t1" })).nodes, 1);
		const created = scopedGraph([chat.id]).nodes.find((n) => n.statement === "Anchored statement")!;
		assert.deepEqual(created.provenance, [{ chatId: chat.id, messageId: "t1" }]);

		const second = merge(
			chat.id,
			{
				propositions: [
					{ id: "q1", name: "Anchored again", statement: "Anchored statement, rephrased", aliases: [], messageId: "t2" },
					{ id: "q2", name: "Follows", statement: "Follows the anchored claim", aliases: [], messageId: "t2" },
				],
				chains: [{ premises: ["q1"], conclusion: "q2" }],
			},
			[{ id: "q1", linkTo: created.id }],
		);
		assert.equal(second.nodes, 1, "q1 linked (no create), q2 created");
		assert.ok(graphStore.readNodes().some((n) => n.id === created.id && n.provenance.some((pt) => pt.chatId === chat.id && pt.messageId === "t2")), "the link-append line carries the re-encounter's passage id");
		const chains = graphStore.readChains().filter((c) => c.provenance.some((pt) => pt.chatId === chat.id));
		assert.equal(chains.length, 1);
		assert.deepEqual(chains[0]!.provenance, [{ chatId: chat.id, messageId: "" }]);
	});

	it("merges INDEPENDENTLY per call (owner, 2026-09-29) but resolves a repeated id once within a submit", () => {
		// Cross-run identity is the AUDITOR's job (linkTo) plus the coverage ledger — never the merger's.
		const rep = fixtureChat("Independence fixture");
		const findings: SessionFindings = {
			propositions: [
				{ id: "p1", name: "Rep one", statement: "Independence one statement", aliases: [] },
				{ id: "p2", name: "Rep two", statement: "Independence two statement", aliases: [] },
				{ id: "p1", name: "Rep one", statement: "Independence one statement", aliases: [] },
			],
			chains: [{ premises: ["p1"], conclusion: "p2" }],
		};
		assert.deepEqual(merge(rep.id, findings), { nodes: 2, chains: 1 });
		assert.deepEqual(merge(rep.id, findings), { nodes: 2, chains: 1 }, "nothing remembered — everything re-creates");
		const graph = scopedGraph([rep.id]);
		assert.equal(graph.nodes.length, 4);
		assert.equal(graph.chains.length, 2);
		assert.equal(graphStore.readCheckpoints().filter((c) => c.chatId === rep.id).length, 2, "one checkpoint line per merge");
	});

	it("the notes front door: source id as chatId, checkpoint at import time, file path in the snapshot (never a chat session)", () => {
		graphStore.upsertSource({ id: "src_notesfixture", filePath: "/vault/learn vim.md", importedAt: "2026-09-13T00:00:00.000Z" });
		const stats = mergeFindings("src_notesfixture", oneProp("p1", "Vim normal mode", "Vim starts in Normal mode."), { links: [] }, graphDeps, { foldedAt: "2026-09-13T00:00:00.000Z" });
		assert.deepEqual(stats, { nodes: 1, chains: 0 });

		const node = getGraph(graphStore).nodes.find((n) => n.statement.startsWith("Vim starts"))!;
		assert.deepEqual(node.provenance, [{ chatId: "src_notesfixture", messageId: "" }]);
		assert.equal(graphStore.readCheckpoints().find((c) => c.chatId === "src_notesfixture")?.foldedAt, "2026-09-13T00:00:00.000Z");
		const snap = graphSnapshot(graphDeps);
		assert.equal(snap.fileSources["src_notesfixture"], "/vault/learn vim.md");
		assert.deepEqual(snap.nodeSessions[node.id], ["src_notesfixture"]);
		assert.equal(snap.sessions["src_notesfixture"], undefined);
	});
});

describe("graph ledger store", () => {
	it("skips corrupt / foreign-shaped lines; returns RAW repeated-id lines that getGraph merges", () => {
		const line = (id: string, msgId: string) =>
			JSON.stringify({ id, name: id, statement: `Phrasing ${msgId}`, aliases: [], createdAt: "2026-08-22T00:00:00.000Z", provenance: [{ chatId: "chat_c", messageId: msgId }] });
		// A torn append and a pre-name-pivot node (old schema: description, no name).
		const legacy = JSON.stringify({ id: "legacy", statement: "Legacy shape", description: "Old schema.", aliases: [], createdAt: "2026-08-22T00:00:00.000Z", provenance: [] });
		fs.appendFileSync(LEDGER_FILES.nodes, `{not json}\n${legacy}\n${line("n_linktest", "m1")}\n${line("n_linktest", "m2")}\n`, "utf-8");

		assert.equal(graphStore.readNodes().some((n) => n.id === "legacy"), false);
		assert.equal(graphStore.readNodes().filter((n) => n.id === "n_linktest").length, 2);
		const merged = getGraph(graphStore).nodes.find((n) => n.id === "n_linktest")!;
		assert.equal(merged.statement, "Phrasing m1", "the FIRST line defines the node");
		assert.ok(merged.aliases.includes("Phrasing m2"));
		assert.deepEqual(merged.provenance.map((p) => p.messageId), ["m1", "m2"]);
	});
});

/** Run fn with the pipeline's globalThis extraction registry holding fake runs. */
function withExtractionRuns(runs: Array<[chatId: string, kind: "chat" | "notes"]>, fn: () => void): void {
	const g = globalThis as { __lhExtractionRuns?: unknown };
	const realRuns = g.__lhExtractionRuns;
	g.__lhExtractionRuns = {
		running: new Map(runs.map(([chatId, kind], i) => [chatId, { chatId, kind, phase: "extracting", startedAt: i + 1, usage: {}, controller: new AbortController() }])),
		inFlight: new Set(),
		lastStartedAt: 0,
	};
	try {
		fn();
	} finally {
		g.__lhExtractionRuns = realRuns;
	}
}

describe("session deletion (deleteChatTraces + deleteChatSession)", () => {
	/** dA creates shared X + orphan Y and asserts X→Y; dB links X, creates Z, asserts X→Z. */
	function buildTwoSessionScenario() {
		const dA = fixtureChat("Deletion session A");
		merge(dA.id, {
			propositions: [
				{ id: "p1", name: "Shared core", statement: "Shared core statement", aliases: ["shared feel"] },
				{ id: "p2", name: "Solo fact", statement: "Solo fact statement", aliases: [] },
			],
			chains: [{ premises: ["p1"], conclusion: "p2" }],
		});
		const bornOf = (chatId: string, statement: string): string =>
			getGraph(graphStore).nodes.find((n) => n.statement === statement && n.provenance.some((pt) => pt.chatId === chatId))!.id;
		const xId = bornOf(dA.id, "Shared core statement");
		const yId = bornOf(dA.id, "Solo fact statement");

		const dB = fixtureChat("Deletion session B");
		merge(
			dB.id,
			{
				propositions: [
					{ id: "q1", name: "Shared again", statement: "Shared core, rephrased", aliases: ["B phrasing"] },
					{ id: "q2", name: "B extra", statement: "B extra statement", aliases: [] },
				],
				chains: [{ premises: ["q1"], conclusion: "q2" }],
			},
			[{ id: "q1", linkTo: xId }],
		);
		const zId = bornOf(dB.id, "B extra statement");

		for (const chat of [dA, dB]) {
			for (const i of [0, 1]) graphStore.appendCoverage({ chatId: chat.id, fp: `${chat.id}-${i}`, tokens: 10, foldedAt: "2026-09-23T00:02:00.000Z" });
		}
		return { dA, dB, xId, yId, zId };
	}

	it("delete-nodes: the shared node survives with the other session's content; the orphan dies; the creator's aliases are stripped (owner ruling 2026-09-23)", () => {
		const { dA, dB, xId, yId, zId } = buildTwoSessionScenario();
		const zLineBefore = JSON.stringify(graphStore.readNodes().find((n) => n.id === zId));

		const stats = deleteChatTraces(graphStore, dA.id, "delete-nodes");
		assert.deepEqual(stats, { nodesRemoved: 1, chainsRemoved: 1, coverageRemoved: 2, checkpointsRemoved: 1 } satisfies ChatDeletionStats);

		const x = getGraph(graphStore).nodes.find((n) => n.id === xId)!;
		assert.equal(x.statement, "Shared core statement", "the shared identity survives");
		assert.ok(!x.aliases.includes("shared feel"), "the deleted creator's phrasings are stripped");
		assert.ok(x.aliases.includes("B phrasing") && x.aliases.includes("Shared core, rephrased"));
		assert.deepEqual(x.provenance, [{ chatId: dB.id, messageId: "" }]);
		assert.equal(graphStore.readNodes().some((n) => n.id === yId), false, "the orphan is gone");
		assert.equal(JSON.stringify(graphStore.readNodes().find((n) => n.id === zId)), zLineBefore, "dB-only node byte-identical");
		const scoped = scopedGraph([dA.id, dB.id]);
		assert.deepEqual(
			scoped.chains.map((c) => [c.premises, c.conclusion, c.provenance]),
			[[[xId], zId, [{ chatId: dB.id, messageId: "" }]]],
			"dA's X⇒Y died with Y; dB's X⇒Z survived",
		);
		const snapshot = graphSnapshot(graphDeps);
		assert.deepEqual(snapshot.nodeSessions[xId], [dB.id]);
		assert.ok(snapshot.sessions[dB.id] && !snapshot.sessions[dA.id]);
		noTempFiles();
		assert.deepEqual(deleteChatTraces(graphStore, dA.id, "delete-nodes"), { nodesRemoved: 0, chainsRemoved: 0, coverageRemoved: 0, checkpointsRemoved: 0 }, "idempotent");
	});

	it("preserve-graph: only the extraction bookkeeping dies — the graph ledgers are byte-identical", () => {
		const { dA, dB } = buildTwoSessionScenario();
		const before = { nodes: graphStore.readNodes(), chains: graphStore.readChains() };
		assert.deepEqual(deleteChatTraces(graphStore, dA.id, "preserve-graph"), { nodesRemoved: 0, chainsRemoved: 0, coverageRemoved: 2, checkpointsRemoved: 1 });
		assert.deepEqual({ nodes: graphStore.readNodes(), chains: graphStore.readChains() }, before);
		assert.equal(graphStore.readCoverage().some((row) => row.chatId === dA.id), false);
		assert.equal(graphStore.readCoverage().some((row) => row.chatId === dB.id), true);
	});

	it("deleteChatSession: the orchestration's gates and the sync block", async () => {
		const notFound = { ok: false, status: 404, code: "not_found", error: "No such session" };
		assert.deepEqual(await deleteChatSession("chat_missing_delete", "delete-nodes"), notFound);

		const { dA } = buildTwoSessionScenario();
		beginTurn(dA.id);
		const turnedAway = await deleteChatSession(dA.id, "delete-nodes");
		assert.ok(!turnedAway.ok && turnedAway.status === 409 && turnedAway.code === "turn_in_flight");
		endTurn(dA.id);

		// Running background jobs block too; a refused delete keeps its notice.
		rememberTurnFailure(dA.id, "The reply could not be saved.");
		const job = jobStore.createJob({ kind: "research", chatId: dA.id, toolCallId: "del-call-1" });
		const jobsBlocked = await deleteChatSession(dA.id, "delete-nodes");
		assert.ok(!jobsBlocked.ok && jobsBlocked.status === 409);
		if (jobsBlocked.code === "jobs_running") assert.deepEqual(jobsBlocked.jobIds, [job.id]);
		assert.match(await settledTurnResponse(dA.id).text(), /The reply could not be saved\./);
		assert.equal(jobStore.deleteJobsForChat(dA.id), 1);

		// Success — a terminal job rides along; the chat record dies last.
		const doneJob = jobStore.createJob({ kind: "research", chatId: dA.id, toolCallId: "del-call-2" });
		jobStore.updateJob(doneJob.id, { status: "done", activity: "delivered" });
		const outcome = await deleteChatSession(dA.id, "delete-nodes");
		assert.ok(outcome.ok);
		assert.equal(outcome.mode, "delete-nodes");
		assert.equal(outcome.stats.nodesRemoved, 1);
		assert.equal(outcome.jobsRemoved, 1);
		assert.ok(outcome.graphRevision > 0);
		assert.equal(chatStore.getChat(dA.id), null);
		assert.doesNotMatch(await settledTurnResponse(dA.id).text(), /"type":"error"/, "deletion clears its transient notice");
		assert.equal(jobStore.getJob(doneJob.id), null);
		assert.deepEqual(await deleteChatSession(dA.id, "delete-nodes"), notFound);
	});
});

describe("single-node deletion (deleteNodeTraces + deleteGraphNode)", () => {
	it("deleteNodeTraces: FULL DEATH — the node's every line and its edges; neighbors and foreign chains untouched", () => {
		graphStore.rewriteLedgers({ nodes: [], chains: [] });
		const node = (id: string, aliases: string[], provenance: GraphNode["provenance"]) =>
			graphStore.appendNode({ id, name: id, statement: `${id} statement`, aliases, createdAt: "2026-09-23T00:00:00.000Z", provenance });
		const chain = (id: string, premise: string, conclusion: string) =>
			graphStore.appendChain({ id, premises: [premise], conclusion, createdAt: "2026-09-23T00:00:00.000Z", provenance: [{ chatId: "chat_node_b", messageId: "m3" }] });
		node("n_dead", [], []); // a legacy notes-born line: EMPTY provenance
		node("n_dead", ["doomed, rephrased"], [{ chatId: "chat_node_a", messageId: "m1" }]);
		node("n_keep", [], [{ chatId: "chat_node_a", messageId: "m2" }]);
		chain("arg_dead_keep", "n_dead", "n_keep");
		chain("arg_keep_dead", "n_keep", "n_dead");
		chain("arg_keep_other", "n_keep", "n_other");
		const keepLineBefore = JSON.stringify(graphStore.readNodes().find((n) => n.id === "n_keep"));

		assert.deepEqual(deleteNodeTraces(graphStore, "n_dead"), { chainsRemoved: 2 });
		assert.equal(graphStore.readNodes().some((n) => n.id === "n_dead"), false);
		assert.equal(JSON.stringify(graphStore.readNodes().find((n) => n.id === "n_keep")), keepLineBefore);
		assert.deepEqual(graphStore.readChains().map((c) => c.id), ["arg_keep_other"]);
		noTempFiles();
		assert.equal(deleteNodeTraces(graphStore, "n_dead"), null, "idempotent");
	});

	it("deleteGraphNode: the orchestration — extraction gate, 404, success", () => {
		assert.deepEqual(deleteGraphNode("n_missing_node"), { ok: false, status: 404, code: "not_found", error: "No such node" });

		// ANY registered run gates it: a mid-flight run could re-reference the dying node.
		withExtractionRuns([["chat_busy", "chat"]], () => {
			const gated = deleteGraphNode("n_gate_probe");
			assert.ok(!gated.ok && gated.status === 409 && gated.code === "extraction_running");
		});

		graphStore.appendNode({ id: "n_orch", name: "Orchestrated", statement: "Orchestrated statement", aliases: [], createdAt: "2026-09-23T00:00:00.000Z", provenance: [{ chatId: "chat_node_c", messageId: "m1" }] });
		const revisionBefore = graphRevision();
		const outcome = deleteGraphNode("n_orch");
		assert.ok(outcome.ok);
		assert.deepEqual(outcome.stats, { chainsRemoved: 0 });
		assert.ok(outcome.graphRevision > 0 && outcome.graphRevision >= revisionBefore);
		assert.equal(graphStore.readNodes().some((n) => n.id === "n_orch"), false);
		assert.equal(deleteGraphNode("n_orch").ok, false);
	});
});

describe("session coverage read", () => {
	it("one session's block: derived uncovered, the newest fold, scoped to this session", () => {
		// Coverage slots are the teacher's text blocks (owner, 2026-09-28).
		const chat = fixtureChat("coverage read", [teacher("cov_t1", "coverage reads"), teacher("cov_t2", "per-session blocks"), teacher("cov_t3", "a third message")]);
		const empty = sessionCoverage(chat.id)!;
		assert.deepEqual(
			[empty.totalMessages, empty.uncoveredCount, empty.coveredTokens, empty.running, empty.lastFoldedAt],
			[3, 3, 0, false, null],
		);

		const slots = coverageSlots(chatStore.getChat(chat.id)!.messages);
		graphStore.appendCoverage({ chatId: chat.id, fp: slots[0]!.fp, tokens: slots[0]!.tokens, foldedAt: "2026-09-24T10:00:00.000Z" });
		graphStore.appendCoverage({ chatId: chat.id, fp: slots[1]!.fp, tokens: slots[1]!.tokens, foldedAt: "2026-09-24T11:30:00.000Z" });
		graphStore.appendCoverage({ chatId: "chat_other", fp: slots[2]!.fp, tokens: slots[2]!.tokens, foldedAt: "2026-09-24T23:00:00.000Z" });

		const cov = sessionCoverage(chat.id)!;
		assert.equal(cov.coveredCount, 2);
		assert.equal(cov.uncoveredCount, 1);
		assert.equal(cov.coveredTokens, slots[0]!.tokens + slots[1]!.tokens);
		assert.equal(cov.uncoveredTokens, slots[2]!.tokens);
		assert.equal(cov.lastFoldedAt, "2026-09-24T11:30:00.000Z");
	});

	it("running: true only for THIS session's chat-kind run; unknown chat → null", () => {
		const chat = fixtureChat("coverage running");
		withExtractionRuns([["src_notes", "notes"], ["other_chat", "chat"]], () => assert.equal(sessionCoverage(chat.id)!.running, false));
		withExtractionRuns([[chat.id, "chat"]], () => assert.equal(sessionCoverage(chat.id)!.running, true));
		assert.equal(sessionCoverage("chat_never_was"), null);
	});
});

describe("deriveView (the argument's geometry)", () => {
	const prop = (id: string): GraphNode => ({ id, name: id.toUpperCase(), statement: `${id} statement`, aliases: [], createdAt: "2026-09-30T00:00:00.000Z", provenance: [] });
	const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({ id, premises, conclusion, provenance: [], createdAt: "2026-09-30T00:00:00.000Z" });
	const props = (...ids: string[]) => ids.map(prop);
	const edges = (list: Array<{ from: string; to: string }>) => list.map((e) => `${e.from}>${e.to}`).sort();

	it("single-premise chains collapse to a direct arrow; multi-premise chains keep an imp node + fan; dangling chains drop", () => {
		const single = deriveView({ nodes: props("a", "b"), chains: [chain("arg_ab", ["a"], "b")] });
		assert.deepEqual(single.nodes.map((n) => n.id), ["a", "b"]);
		assert.deepEqual(single.edges, [{ from: "a", to: "b" }]);

		const multi = deriveView({ nodes: props("a", "b", "c"), chains: [chain("arg_ab", ["a", "b"], "c")] });
		assert.deepEqual(multi.nodes.map((n) => n.id).sort(), ["a", "arg_ab", "b", "c"]);
		assert.deepEqual(edges(multi.edges), ["a>arg_ab", "arg_ab>c", "b>arg_ab"]);

		const dangling = deriveView({ nodes: props("a"), chains: [chain("arg_ghost", ["a"], "gone"), chain("arg_gone", ["ghost"], "a")] });
		assert.deepEqual(dangling.nodes.map((n) => n.id), ["a"]);
		assert.deepEqual(dangling.edges, []);
	});

	it("two chains SHARING a conclusion stay distinct — never a unioned fan", () => {
		const view = deriveView({ nodes: props("a", "b", "c", "d", "e"), chains: [chain("arg_e1", ["a", "b"], "e"), chain("arg_e2", ["c", "d"], "e")] });
		assert.deepEqual(view.nodes.map((n) => n.id).sort(), ["a", "arg_e1", "arg_e2", "b", "c", "d", "e"]);
		assert.ok(edges(view.edges).includes("arg_e1>e") && edges(view.edges).includes("arg_e2>e"));
	});

	it("LOGICAL edges contract every chain to deduped premise→conclusion arrows; impLinks cover MULTI-premise chains only", () => {
		const view = deriveView({ nodes: props("a", "b", "c"), chains: [chain("arg_ab", ["a", "b"], "c"), chain("arg_ac", ["a"], "c")] });
		assert.deepEqual(edges(view.logicalEdges), ["a>c", "b>c"]);
		assert.deepEqual(view.impLinks, [{ id: "arg_ab", premises: ["a", "b"], conclusion: "c" }]);
	});
});
