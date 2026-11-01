/**
 * Graph merger + deletion + coverage + derivation tests.
 * The merger (core/graph.ts mergeFindings) is the pipeline's deterministic
 * apply stage: AUDITED VERDICTS in, ledger appends out — link-or-create
 * identity (the auditor's linkTo, never string matching) and the
 * idempotency guarantees.
 *
 * Ledger isolation: PATHS is fixed at import time, so the data/graph
 * ledgers are backed up and cleared before the suite and restored after.
 * The chat fixtures are real ChatRecords in the chat store (created and
 * deleted by this suite). The full LLM pipeline (extractor → auditor) is
 * tested in tests/extraction.test.ts with mock models.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import type { GraphChain, GraphNode, SessionFindings } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { deriveView, getGraph, graphSnapshot, mergeFindings, type GraphDeps } from "../src/core/graph.ts";
import { coverageSlots } from "../src/core/coverage.ts";
import { graphStore } from "../src/store/graph.ts";
import { chatStore } from "../src/store/chats.ts";
import { LEDGER_FILES, PATHS, SOURCES_FILE } from "../config.ts";

/** The wired fs adapters, exactly what src/server/stores.ts passes in production. */
const graphDeps = { chatStore, graphStore } as const satisfies GraphDeps;

/** The session merge source for a chat — what the pipeline passes: the fold stamp only. */
function sessionSource(chatId: string): { foldedAt: string } {
	return { foldedAt: chatStore.getChat(chatId)!.updatedAt };
}

// ─── ledger isolation (backup-and-clear of data/graph/*.jsonl) ──────────────

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
	for (const file of LEDGER_PATHS) {
		try {
			fs.unlinkSync(file);
		} catch {
			/* nothing was written here */
		}
	}
	for (const { file, bak } of backups) fs.renameSync(bak, file);
	for (const id of createdChats) {
		try {
			fs.unlinkSync(`${PATHS.chats}/${id}.json`);
		} catch {
			/* already gone */
		}
	}
});

// ─── fixture builders ────────────────────────────────────────────────────────

function user(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: Date.now() } as never;
}

/** A teacher-prose message (the coverage unit, owner 2026-09-28). */
function teacher(id: string, text: string): LhMessage {
	return { id, role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as never;
}

/** Create a chat in the real store with messages (the merger reads no transcript). */
function fixtureChat(title: string, messages: LhMessage[] = [user("u1", title)]) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, messages);
	return chatStore.getChat(chat.id)!;
}

/** Single-proposition findings (no chains). */
function oneProp(id: string, name: string, statement: string, extra: { aliases?: string[]; messageId?: string } = {}): SessionFindings {
	return { propositions: [{ id, name, statement, aliases: extra.aliases ?? [], ...(extra.messageId ? { messageId: extra.messageId } : {}) }], chains: [] };
}

/** The chat every merger test folds (shared, so ordering is intentional). */
const chat1 = fixtureChat("Graph fixture");

/** Set by the linkTo test; the sessions-index test (which runs after) reads it. */
let chat2Id = "";

// ─── the merger ──────────────────────────────────────────────────────────────

/** Everything the graph holds for a set of chats (other processes' test
 *  emissions run concurrently against the same files — scope, never assume). */
function scopedGraph(chatIds: string[]) {
	const graph = getGraph(graphStore);
	return {
		nodes: graph.nodes.filter((n) => n.provenance.some((pt) => chatIds.includes(pt.chatId))),
		chains: graph.chains.filter((c) => c.provenance.some((pt) => chatIds.includes(pt.chatId))),
	};
}

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
		const stats = mergeFindings(chat1.id, findings, { links: [] }, graphDeps, sessionSource(chat1.id));
		assert.deepEqual(stats, { nodes: 3, chains: 1 });

		const graph = scopedGraph([chat1.id]);
		assert.equal(graph.nodes.length, 3);
		const idByStatement = new Map(graph.nodes.map((n) => [n.statement, n.id]));
		// No messageId submitted → provenance stays CHAT-LEVEL.
		const alpha = graph.nodes.find((n) => n.statement === "Alpha intuition")!;
		assert.match(alpha.id, /^n_/);
		assert.deepEqual(alpha.provenance, [{ chatId: chat1.id, messageId: "" }]);

		assert.equal(graph.chains.length, 1);
		const chain = graph.chains[0]!;
		assert.match(chain.id, /^arg_/, "store-minted argument id");
		assert.deepEqual(chain.premises, [idByStatement.get("Alpha intuition")]);
		assert.equal(chain.conclusion, idByStatement.get("Beta rule"));
		assert.deepEqual(chain.provenance, [{ chatId: chat1.id, messageId: "" }]);
	});

	it("messageId anchors (2026-10-13): creates AND link-appends stamp the passage id; chains stay chat-level", () => {
		const chat = fixtureChat("Anchor fixture", [user("u1", "teach anchors"), teacher("t1", "First."), teacher("t2", "Second.")]);
		const first = mergeFindings(chat.id, oneProp("p1", "Anchored", "Anchored statement", { messageId: "t1" }), { links: [] }, graphDeps, sessionSource(chat.id));
		assert.equal(first.nodes, 1);
		const created = scopedGraph([chat.id]).nodes.find((n) => n.statement === "Anchored statement")!;
		assert.deepEqual(created.provenance, [{ chatId: chat.id, messageId: "t1" }], "the created node anchors to its passage");

		// The re-encounter: link-appended, anchored to ITS passage — while
		// the chain the same job asserts stays chat-level.
		const second = mergeFindings(
			chat.id,
			{
				propositions: [
					{ id: "q1", name: "Anchored again", statement: "Anchored statement, rephrased", aliases: [], messageId: "t2" },
					{ id: "q2", name: "Follows", statement: "Follows the anchored claim", aliases: [], messageId: "t2" },
				],
				chains: [{ premises: ["q1"], conclusion: "q2" }],
			},
			{ links: [{ id: "q1", linkTo: created.id }] },
			graphDeps,
			sessionSource(chat.id),
		);
		assert.equal(second.nodes, 1, "q1 linked (no create), q2 created");
		const linkLine = graphStore
			.readNodes()
			.filter((n) => n.id === created.id)
			.find((line) => line.provenance.some((pt) => pt.chatId === chat.id && pt.messageId === "t2"));
		assert.ok(linkLine, "the link-append line carries the re-encounter's passage id");
		const chains = graphStore.readChains().filter((c) => c.provenance.some((pt) => pt.chatId === chat.id));
		assert.equal(chains.length, 1);
		assert.deepEqual(chains[0]!.provenance, [{ chatId: chat.id, messageId: "" }], "chains stay chat-level — never anchored");
	});

	it("merges INDEPENDENTLY per call — no cross-run identity (owner, 2026-09-29)", () => {
		// Resolution is a job-local in-memory map: cross-run identity is the
		// AUDITOR's job (linkTo) plus the coverage ledger — never the merger's.
		const rep = fixtureChat("Independence fixture");
		const findings: SessionFindings = {
			propositions: [
				{ id: "p1", name: "Rep one", statement: "Independence one statement", aliases: [] },
				{ id: "p2", name: "Rep two", statement: "Independence two statement", aliases: [] },
			],
			chains: [{ premises: ["p1"], conclusion: "p2" }],
		};
		assert.deepEqual(mergeFindings(rep.id, findings, { links: [] }, graphDeps, sessionSource(rep.id)), { nodes: 2, chains: 1 });
		assert.deepEqual(mergeFindings(rep.id, findings, { links: [] }, graphDeps, sessionSource(rep.id)), { nodes: 2, chains: 1 }, "nothing remembered — everything re-creates");
		const graph = scopedGraph([rep.id]);
		assert.equal(graph.nodes.length, 4);
		assert.equal(graph.chains.length, 2);
		assert.equal(graphStore.readCheckpoints().filter((c) => c.chatId === rep.id).length, 2, "one checkpoint line per merge");
	});

	it("is idempotent WITHIN one submit — a repeated proposition id resolves once", () => {
		const dup = fixtureChat("Duplicate-id fixture");
		const findings: SessionFindings = {
			propositions: [
				{ id: "p1", name: "Dup", statement: "Dup statement", aliases: [] },
				{ id: "p1", name: "Dup", statement: "Dup statement", aliases: [] },
			],
			chains: [],
		};
		assert.deepEqual(mergeFindings(dup.id, findings, { links: [] }, graphDeps, sessionSource(dup.id)), { nodes: 1, chains: 0 });
	});

	it("applies a linkTo verdict: phrasings join aliases, provenance unions, no duplicate node", () => {
		const alphaId = scopedGraph([chat1.id]).nodes.find((n) => n.statement === "Alpha intuition")!.id;
		const chat2 = fixtureChat("Graph fixture 2");
		chat2Id = chat2.id;
		// A DIFFERENT phrasing — identity is the verdict, not strings.
		const stats = mergeFindings(chat2.id, oneProp("q1", "Alpha", "Alpha feel", { aliases: ["alpha intuition"] }), { links: [{ id: "q1", linkTo: alphaId }] }, graphDeps, sessionSource(chat2.id));
		assert.deepEqual(stats, { nodes: 0, chains: 0 });

		assert.equal(scopedGraph([chat1.id, chat2.id]).nodes.length, 3, "no duplicate node");
		const alpha = getGraph(graphStore).nodes.find((n) => n.id === alphaId)!;
		assert.ok(alpha.aliases.includes("Alpha feel") && alpha.aliases.includes("alpha intuition"));
		assert.ok(alpha.provenance.some((pt) => pt.chatId === chat2.id), "provenance unions");
	});

	it("derives the sessions index in graphSnapshot", () => {
		const snap = graphSnapshot(graphDeps);
		const idByStatement = new Map(snap.nodes.map((n) => [n.statement, n.id]));
		assert.equal(snap.sessions[chat1.id], "Graph fixture");
		assert.equal(snap.sessions[chat2Id], "Graph fixture 2");
		assert.deepEqual((snap.nodeSessions[idByStatement.get("Alpha intuition")!] ?? []).sort(), [chat1.id, chat2Id].sort());
		assert.deepEqual(snap.nodeSessions[idByStatement.get("Gamma application")!], [chat1.id]);
	});

	it("never string-matches without a verdict — an identical statement without linkTo is a NEW node", () => {
		const chat3 = fixtureChat("Graph fixture 3");
		const stats = mergeFindings(chat3.id, oneProp("r1", "Alpha", "Alpha intuition"), { links: [] }, graphDeps, sessionSource(chat3.id));
		assert.equal(stats.nodes, 1, "created — the merger does not match strings");
		assert.equal(getGraph(graphStore).nodes.filter((n) => n.statement === "Alpha intuition").length, 2);
	});

	it("the notes front door: source id as chatId, checkpoint at import time, file path in the snapshot (never a chat session)", () => {
		graphStore.upsertSource({ id: "src_notesfixture", filePath: "/vault/learn vim.md", importedAt: "2026-09-13T00:00:00.000Z" });
		const stats = mergeFindings("src_notesfixture", oneProp("p1", "Vim normal mode", "Vim starts in Normal mode, where keys are commands."), { links: [] }, graphDeps, { foldedAt: "2026-09-13T00:00:00.000Z" });
		assert.deepEqual(stats, { nodes: 1, chains: 0 });

		const node = getGraph(graphStore).nodes.find((n) => n.statement.startsWith("Vim starts"))!;
		assert.deepEqual(node.provenance, [{ chatId: "src_notesfixture", messageId: "" }]);
		assert.equal(graphStore.readCheckpoints().find((c) => c.chatId === "src_notesfixture")?.foldedAt, "2026-09-13T00:00:00.000Z");
		const snap = graphSnapshot(graphDeps);
		assert.equal(snap.fileSources["src_notesfixture"], "/vault/learn vim.md");
		assert.deepEqual(snap.nodeSessions[node.id], ["src_notesfixture"]);
		assert.equal(snap.sessions["src_notesfixture"], undefined, "a notes source is never a chat session");
	});
});

// ─── store primitives ────────────────────────────────────────────────────────

describe("graph ledger store", () => {
	it("round-trips lines and skips corrupt / foreign-shaped lines (strict reads)", () => {
		graphStore.appendNode({ id: "n_storetest", name: "Store test", statement: "Store test, elaborated.", aliases: [], createdAt: "2026-08-22T00:00:00.000Z", provenance: [{ chatId: "chat_c", messageId: "m1" }] });
		// A torn append and a pre-name-pivot node (old schema: description, no
		// name) — both skipped by the strict guard.
		fs.appendFileSync(
			LEDGER_FILES.nodes,
			`{not json}\n${JSON.stringify({ id: "legacy", statement: "Legacy shape", description: "Old schema.", aliases: [], createdAt: "2026-08-22T00:00:00.000Z", provenance: [] })}\n`,
			"utf-8",
		);
		const nodes = graphStore.readNodes().filter((n) => n.id === "n_storetest" || n.id === "legacy");
		assert.equal(nodes.length, 1);
		assert.equal(nodes[0]!.name, "Store test");
		assert.deepEqual(nodes[0]!.provenance, [{ chatId: "chat_c", messageId: "m1" }]);
	});

	it("returns RAW node lines — repeated ids (link-appends) are each their own line; getGraph merges", () => {
		const line = (msgId: string) =>
			JSON.stringify({ id: "n_linktest", name: "Link test", statement: `Phrasing ${msgId}`, aliases: [], createdAt: "2026-08-22T00:00:00.000Z", provenance: [{ chatId: "chat_c", messageId: msgId }] });
		fs.appendFileSync(LEDGER_FILES.nodes, `${line("m1")}\n${line("m2")}\n`, "utf-8");
		assert.equal(graphStore.readNodes().filter((n) => n.id === "n_linktest").length, 2, "the store returns raw lines, one per append");
		const merged = getGraph(graphStore).nodes.find((n) => n.id === "n_linktest")!;
		assert.equal(merged.statement, "Phrasing m1", "the FIRST line defines the node");
		assert.ok(merged.aliases.includes("Phrasing m2"), "later phrasings join the aliases");
		assert.deepEqual(merged.provenance.map((p) => p.messageId), ["m1", "m2"]);
	});
});

// ─── session deletion (wave 6 — the first destructive ledger operation) ─────

import { deleteChatTraces, deleteNodeTraces, type ChatDeletionStats, type NodeDeletionStats } from "../src/core/graph-deletion.ts";
import { deleteChatSession, sessionCoverage } from "../src/server/chats.ts";
import { rememberTurnFailure, settledTurnResponse } from "../src/server/turn-runs.ts";
import { beginTurn, endTurn } from "../src/server/turn-liveness.ts";
import { jobStore } from "../src/store/jobs.ts";
import { deleteGraphNode, graphRevision } from "../src/server/graph.ts";

/** Run fn with the pipeline's globalThis extraction registry holding fake
 *  runs (the honest way to pin the gates without staging a real run). */
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

describe("session deletion (deleteChatTraces + deleteChatSession, wave 6)", () => {
	/** Two-session scenario: dA creates the shared node X + the orphan Y and
	 *  asserts X→Y; dB links X (its own phrasings), creates Z, asserts X→Z.
	 *  Deleting dA must: keep X (dB's link line survives, dA's create-line
	 *  aliases stripped — the identity stays), kill Y (orphan), keep Z and
	 *  dB's edge, kill dA's coverage/checkpoints. */
	function buildTwoSessionScenario() {
		const dA = fixtureChat("Deletion session A");
		const findingsA: SessionFindings = {
			propositions: [
				{ id: "p1", name: "Shared core", statement: "Shared core statement", aliases: ["shared feel"], },
				{ id: "p2", name: "Solo fact", statement: "Solo fact statement", aliases: ["solo feel"], },
			],
			chains: [{ premises: ["p1"], conclusion: "p2", }],
		};
		mergeFindings(dA.id, findingsA, { links: [] }, graphDeps, sessionSource(dA.id));
		// Resolve through THIS session's provenance — the shared ledger
		// holds lookalike statements from earlier tests, so scope by chat.
		const bornOf = (chatId: string, statement: string): string =>
			getGraph(graphStore).nodes.find((n) => n.statement === statement && n.provenance.some((pt) => pt.chatId === chatId))!.id;
		const xId = bornOf(dA.id, "Shared core statement");
		const yId = bornOf(dA.id, "Solo fact statement");

		const dB = fixtureChat("Deletion session B");
		const findingsB: SessionFindings = {
			propositions: [
				{ id: "q1", name: "Shared again", statement: "Shared core, rephrased", aliases: ["B phrasing"] },
				{ id: "q2", name: "B extra", statement: "B extra statement", aliases: ["b extra feel"], },
			],
			chains: [{ premises: ["q1"], conclusion: "q2", }],
		};
		mergeFindings(dB.id, findingsB, { links: [{ id: "q1", linkTo: xId }] }, graphDeps, sessionSource(dB.id));
		const zId = bornOf(dB.id, "B extra statement");

		// Coverage rows (both chats) — the deletion prunes the ledger.
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

		// X survives: identity from the create line intact, dA's aliases +
		// provenance gone, dB's phrasings in.
		const x = getGraph(graphStore).nodes.find((n) => n.id === xId)!;
		assert.equal(x.statement, "Shared core statement", "the shared identity survives");
		assert.ok(!x.aliases.includes("shared feel"), "the deleted creator's phrasings are stripped (owner ruling)");
		assert.ok(x.aliases.includes("B phrasing") && x.aliases.includes("Shared core, rephrased"));
		assert.deepEqual(x.provenance, [{ chatId: dB.id, messageId: "" }], "only dB's provenance remains");
		// Y (the orphan) is gone entirely.
		assert.equal(graphStore.readNodes().some((n) => n.id === yId), false);
		// Z (dB-only) is untouched, byte-identical.
		assert.equal(JSON.stringify(graphStore.readNodes().find((n) => n.id === zId)), zLineBefore);
		// Chains: dA's argument X⇒Y died (Y died); dB's X⇒Z survived.
		const scoped = scopedGraph([dA.id, dB.id]);
		assert.equal(scoped.chains.length, 1);
		assert.deepEqual(scoped.chains[0]!.premises, [xId]);
		assert.equal(scoped.chains[0]!.conclusion, zId);
		assert.deepEqual(scoped.chains[0]!.provenance, [{ chatId: dB.id, messageId: "" }]);
		// The snapshot resolves X to dB only — the deleted chat left no ghost.
		const snapshot = graphSnapshot(graphDeps);
		assert.deepEqual(snapshot.nodeSessions[xId], [dB.id]);
		assert.ok(snapshot.sessions[dB.id] && !snapshot.sessions[dA.id]);
		// Atomic rewrites left no temp files.
		assert.equal(fs.readdirSync(PATHS.graph).filter((f) => f.includes(".tmp-")).length, 0);
		// Idempotent: a second run finds nothing.
		assert.deepEqual(deleteChatTraces(graphStore, dA.id, "delete-nodes"), { ...stats, nodesRemoved: 0, chainsRemoved: 0, coverageRemoved: 0, checkpointsRemoved: 0 } satisfies ChatDeletionStats);
	});

	it("preserve-graph: only the extraction bookkeeping dies — the graph ledgers are byte-identical", () => {
		const { dA, dB } = buildTwoSessionScenario();
		const before = { nodes: graphStore.readNodes(), chains: graphStore.readChains() };
		const stats = deleteChatTraces(graphStore, dA.id, "preserve-graph");
		assert.deepEqual(stats, { nodesRemoved: 0, chainsRemoved: 0, coverageRemoved: 2, checkpointsRemoved: 1 } satisfies ChatDeletionStats);
		assert.deepEqual(graphStore.readNodes(), before.nodes);
		assert.deepEqual(graphStore.readChains(), before.chains);
		assert.equal(graphStore.readCoverage().some((row) => row.chatId === dA.id), false);
		assert.equal(graphStore.readCoverage().some((row) => row.chatId === dB.id), true);
	});

	it("deleteChatSession: the orchestration's gates and the sync block", async () => {
		// 404 — unknown chat.
		assert.deepEqual(await deleteChatSession("chat_missing_delete", "delete-nodes"), { ok: false, status: 404, code: "not_found", error: "No such session" });

		const { dA } = buildTwoSessionScenario();
		// 409 — a turn in flight.
		beginTurn(dA.id);
		const turnedAway = await deleteChatSession(dA.id, "delete-nodes");
		assert.ok(!turnedAway.ok && turnedAway.status === 409 && turnedAway.code === "turn_in_flight");
		endTurn(dA.id);
		// 409 — running background jobs; a refused delete keeps its notice.
		rememberTurnFailure(dA.id, "The reply could not be saved.");
		const job = jobStore.createJob({ kind: "research", chatId: dA.id, toolCallId: "del-call-1" });
		const jobsBlocked = await deleteChatSession(dA.id, "delete-nodes");
		assert.ok(!jobsBlocked.ok && jobsBlocked.status === 409, "refused with 409");
		if (jobsBlocked.code === "jobs_running") assert.deepEqual(jobsBlocked.jobIds, [job.id]);
		assert.match(await settledTurnResponse(dA.id).text(), /The reply could not be saved\./);
		assert.equal(jobStore.deleteJobsForChat(dA.id), 1, "test cleanup — the job file is gone");

		// Success — a terminal job rides along; the chat record dies last.
		const doneJob = jobStore.createJob({ kind: "research", chatId: dA.id, toolCallId: "del-call-2" });
		jobStore.updateJob(doneJob.id, { status: "done", activity: "delivered" });
		const outcome = await deleteChatSession(dA.id, "delete-nodes");
		assert.equal(outcome.ok, true);
		if (outcome.ok) {
			assert.equal(outcome.mode, "delete-nodes");
			assert.equal(outcome.stats.nodesRemoved, 1);
			assert.equal(outcome.jobsRemoved, 1);
			assert.ok(outcome.graphRevision > 0, "the version stamp moved");
		}
		assert.equal(chatStore.getChat(dA.id), null, "the chat record is gone");
		assert.doesNotMatch(await settledTurnResponse(dA.id).text(), /"type":"error"/, "deletion clears its transient notice");
		assert.equal(jobStore.getJob(doneJob.id), null, "the chat's job records are gone");
		// And a second call is an honest 404.
		assert.deepEqual(await deleteChatSession(dA.id, "delete-nodes"), { ok: false, status: 404, code: "not_found", error: "No such session" });
	});
});

// ─── single-node deletion (node interlude, full death) ───────────────────────

describe("single-node deletion (deleteNodeTraces + deleteGraphNode, node interlude)", () => {
	/** The full-death scenario: node X is born in a notes file (EMPTY
	 *  provenance — a legacy line; the mappings anchor is gone, owner
	 *  2026-09-29), re-encountered by a chat (link line: alias +
	 *  provenance), and asserted in chains by two sessions. */
	function buildNodeScenario() {
		// Clean slate per test: each test in this describe builds its own
		// scenario from empty ledgers (the suite's isolation covers the
		// whole file; this covers describe-internal stacking).
		graphStore.rewriteLedgers({ nodes: [], chains: [] });
		const node = (id: string, aliases: string[], provenance: GraphNode["provenance"]) =>
			graphStore.appendNode({ id, name: id, statement: `${id} statement`, aliases, createdAt: "2026-09-23T00:00:00.000Z", provenance });
		node("n_dead", [], []);
		// The chat's re-encounter: a link line (alias + its own provenance).
		node("n_dead", ["doomed, rephrased"], [{ chatId: "chat_node_a", messageId: "m1" }]);
		// A neighbor + two edges: only the one touching X dies.
		node("n_keep", [], [{ chatId: "chat_node_a", messageId: "m2" }]);
		graphStore.appendChain({ id: "arg_dead_keep", premises: ["n_dead"], conclusion: "n_keep", createdAt: "2026-09-23T00:00:00.000Z", provenance: [{ chatId: "chat_node_a", messageId: "m1" }] });
		graphStore.appendChain({ id: "arg_keep_dead", premises: ["n_keep"], conclusion: "n_dead", createdAt: "2026-09-23T00:00:00.000Z", provenance: [{ chatId: "chat_node_b", messageId: "m3" }] });
		// A FOREIGN chain the deletion must not touch (destructive rewriting
		// may not exceed the blast radius — foreign data rides untouched).
		graphStore.appendChain({ id: "arg_keep_other", premises: ["n_keep"], conclusion: "n_other", createdAt: "2026-09-23T00:00:00.000Z", provenance: [{ chatId: "chat_node_b", messageId: "m3" }] });
	}

	it("deleteNodeTraces: FULL DEATH — the node, its edges, its evidence, its anchors", () => {
		buildNodeScenario();
		const keepLineBefore = JSON.stringify(graphStore.readNodes().find((n) => n.id === "n_keep"));
		const stats = deleteNodeTraces(graphStore, "n_dead");
		assert.deepEqual(stats, { chainsRemoved: 2 } satisfies NodeDeletionStats);

		// Every line of the node is gone; the neighbor is byte-identical.
		assert.equal(graphStore.readNodes().some((n) => n.id === "n_dead"), false);
		assert.equal(JSON.stringify(graphStore.readNodes().find((n) => n.id === "n_keep")), keepLineBefore);
		// Only the chains referencing X died; the foreign chain stays.
		assert.deepEqual(
			graphStore.readChains().map((c) => [c.premises, c.conclusion]),
			[[["n_keep"], "n_other"]],
		);
		assert.equal(fs.readdirSync(PATHS.graph).filter((f) => f.includes(".tmp-")).length, 0);
		assert.equal(deleteNodeTraces(graphStore, "n_dead"), null, "idempotent: a second run finds no node");
	});

	it("deleteGraphNode: the orchestration — extraction gate, 404, success", () => {
		assert.deepEqual(deleteGraphNode("n_missing_node"), { ok: false, status: 404, code: "not_found", error: "No such node" });

		// 409 — ANY registered extraction run: a mid-flight run could
		// re-reference the dying node; the run is never aborted (its spend
		// belongs to another session), the caller retries.
		withExtractionRuns([["chat_busy", "chat"]], () => {
			const gated = deleteGraphNode("n_gate_probe");
			assert.ok(!gated.ok && gated.status === 409 && gated.code === "extraction_running");
		});

		// Success — the node dies, the version stamp moves.
		graphStore.appendNode({ id: "n_orch", name: "Orchestrated", statement: "Orchestrated statement", aliases: [], createdAt: "2026-09-23T00:00:00.000Z", provenance: [{ chatId: "chat_node_c", messageId: "m1" }] });
		const revisionBefore = graphRevision();
		const outcome = deleteGraphNode("n_orch");
		assert.ok(outcome.ok);
		assert.deepEqual(outcome.stats, { chainsRemoved: 0 });
		assert.ok(outcome.graphRevision > 0 && outcome.graphRevision >= revisionBefore, "the version stamp moved");
		assert.equal(graphStore.readNodes().some((n) => n.id === "n_orch"), false);
		assert.equal(deleteGraphNode("n_orch").ok, false, "a second call is an honest 404");
	});
});

describe("session coverage read (extraction-UX redesign, 2026-09-24)", () => {
	it("one session's block: derived uncovered, the newest fold, honest nulls", () => {
		// Empty coverage: everything uncovered, no fold yet, not running.
		// Teacher prose only (owner, 2026-09-28): coverage slots are the
		// teacher's text blocks, so the fixture is all-teacher.
		const chat = fixtureChat("coverage read", [
			teacher("cov_t1", "tell me about coverage reads"),
			teacher("cov_t2", "and about per-session blocks"),
			teacher("cov_t3", "a third distinct message"),
		]);
		const empty = sessionCoverage(chat.id)!;
		assert.equal(empty.totalMessages, 3);
		assert.equal(empty.uncoveredCount, 3);
		assert.equal(empty.coveredTokens, 0);
		assert.equal(empty.running, false);
		assert.equal(empty.lastFoldedAt, null, "no fold yet");

		// Fold the first two messages: the read derives the split + the
		// newest fold timestamp from the ledger rows.
		const slots = coverageSlots(chatStore.getChat(chat.id)!.messages);
		graphStore.appendCoverage({ chatId: chat.id, fp: slots[0]!.fp, tokens: slots[0]!.tokens, foldedAt: "2026-09-24T10:00:00.000Z" });
		graphStore.appendCoverage({ chatId: chat.id, fp: slots[1]!.fp, tokens: slots[1]!.tokens, foldedAt: "2026-09-24T11:30:00.000Z" });
		// Another session's row must not leak into this read.
		graphStore.appendCoverage({ chatId: "chat_other", fp: slots[2]!.fp, tokens: slots[2]!.tokens, foldedAt: "2026-09-24T23:00:00.000Z" });

		const cov = sessionCoverage(chat.id)!;
		assert.equal(cov.totalMessages, 3);
		assert.equal(cov.coveredCount, 2);
		assert.equal(cov.uncoveredCount, 1);
		assert.equal(cov.coveredTokens, slots[0]!.tokens + slots[1]!.tokens);
		assert.equal(cov.uncoveredTokens, slots[2]!.tokens);
		assert.equal(cov.lastFoldedAt, "2026-09-24T11:30:00.000Z", "the NEWEST fold, and scoped to this session's rows");
	});

	it("running: true only for THIS session's chat-kind run (the registry pin); unknown chat → null", () => {
		const chat = fixtureChat("coverage running");
		// a notes run for the same id is NOT this session's chat run
		withExtractionRuns([["src_notes", "notes"], ["other_chat", "chat"]], () => assert.equal(sessionCoverage(chat.id)!.running, false));
		withExtractionRuns([[chat.id, "chat"]], () => assert.equal(sessionCoverage(chat.id)!.running, true));
		assert.equal(sessionCoverage("chat_never_was"), null, "the caller owns the 404");
	});
});

// ─── deriveView (the rendering arc, owner 2026-09-30) ────────────────────────

describe("deriveView (the argument's geometry)", () => {
	const prop = (id: string): GraphNode => ({ id, name: id.toUpperCase(), statement: `${id} statement`, aliases: [], createdAt: "2026-09-30T00:00:00.000Z", provenance: [] });
	const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({ id, premises, conclusion, provenance: [], createdAt: "2026-09-30T00:00:00.000Z" });
	const edgeKey = (e: { from: string; to: string }) => `${e.from}>${e.to}`;
	const byEdge = (x: { from: string; to: string }, y: { from: string; to: string }) => (edgeKey(x) < edgeKey(y) ? -1 : 1);

	it("a SINGLE-premise chain collapses to ONE direct arrow — no imp node", () => {
		const view = deriveView({ nodes: [prop("a"), prop("b")], chains: [chain("arg_ab", ["a"], "b")] });
		assert.deepEqual(view.nodes.map((n) => n.id), ["a", "b"], "no arg_ node minted");
		assert.deepEqual(view.edges, [{ from: "a", to: "b" }], "the argument IS a plain arrow");
	});

	it("a MULTI-premise chain keeps the imp node + fan (premises in, conclusion out)", () => {
		const view = deriveView({
			nodes: [prop("a"), prop("b"), prop("c")],
			chains: [chain("arg_ab", ["a", "b"], "c")],
		});
		assert.deepEqual(view.nodes.map((n) => n.id).sort(), ["a", "arg_ab", "b", "c"]);
		assert.deepEqual([...view.edges].sort(byEdge), [
			{ from: "a", to: "arg_ab" },
			{ from: "arg_ab", to: "c" },
			{ from: "b", to: "arg_ab" },
		]);
	});

	it("two chains SHARING a conclusion stay distinct — two geometry points, never a unioned fan", () => {
		const view = deriveView({
			nodes: [prop("a"), prop("b"), prop("c"), prop("d"), prop("e")],
			chains: [chain("arg_e1", ["a", "b"], "e"), chain("arg_e2", ["c", "d"], "e")],
		});
		assert.deepEqual(
			view.nodes.map((n) => n.id).sort(),
			["a", "arg_e1", "arg_e2", "b", "c", "d", "e"],
		);
		assert.ok(view.edges.some((x) => x.from === "arg_e1" && x.to === "e"));
		assert.ok(view.edges.some((x) => x.from === "arg_e2" && x.to === "e"));
	});

	it("dangling chains drop (missing member — the honest belt)", () => {
		const view = deriveView({ nodes: [prop("a")], chains: [chain("arg_ghost", ["a"], "gone"), chain("arg_gone", ["ghost"], "a")] });
		assert.deepEqual(view.nodes.map((n) => n.id), ["a"]);
		assert.deepEqual(view.edges, []);
	});

	it("LOGICAL edges contract every chain to deduped premise→conclusion arrows; impLinks cover MULTI-premise chains only", () => {
		const view = deriveView({
			nodes: [prop("a"), prop("b"), prop("c")],
			chains: [chain("arg_ab", ["a", "b"], "c"), chain("arg_ac", ["a"], "c")],
		});
		// arg_ab: a→c AND b→c; arg_ac: a→c again → deduped to one arrow.
		assert.deepEqual([...view.logicalEdges].sort(byEdge), [
			{ from: "a", to: "c" },
			{ from: "b", to: "c" },
		]);
		assert.deepEqual(view.impLinks, [{ id: "arg_ab", premises: ["a", "b"], conclusion: "c" }]);
	});
});
