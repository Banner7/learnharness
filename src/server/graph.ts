import * as fs from "node:fs";
import { GRAPH_FORMAT_FILE, LEDGER_FILES, PATHS, POSITIONS_FILE } from "../../config.ts";
import type { ExtractionRunUsage, GraphSnapshot, NotesSource } from "../core/contracts.ts";
import type { GraphCostSummary } from "../core/cost-summary.ts";
import { graphCostSummary } from "../core/cost-summary.ts";
import { graphSnapshot } from "../core/graph.ts";
import { danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";
import { birthSessionPartition } from "../core/session-clusters.ts";
import {
	deleteNodeTraces,
	type NodeDeletionStats,
} from "../core/graph-deletion.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { stores } from "./stores.ts";
import { callCost } from "./pricing.ts";

/** Ledger cache (2026-10-31): view projections copy rows before merging;
 * changed ledger stamps invalidate the parsed lines, while format-stamp
 * changes still run the store's downgrade refusal. Source labels stay fresh
 * per request because a renamed chat needs no ledger write. */
function cachedLedger<T>(file: string, read: () => T[]): () => T[] {
	let stamp: string | undefined;
	let rows: T[] = [];
	return () => {
		let next = "absent";
		try {
			const { mtimeMs, ctimeMs, size, ino } = fs.statSync(file);
			next = `${mtimeMs}:${ctimeMs}:${size}:${ino}`;
		} catch {
			// An absent ledger reads empty, including after deletion.
		}
		try {
			const { mtimeMs, size } = fs.statSync(GRAPH_FORMAT_FILE);
			next += `:format:${mtimeMs}:${size}`;
		} catch {
			next += ":format:absent";
		}
		if (next !== stamp) {
			rows = read();
			stamp = next;
		}
		return rows;
	};
}

const readNodes = cachedLedger(LEDGER_FILES.nodes, () => stores.graphStore.readNodes());
const readChains = cachedLedger(LEDGER_FILES.chains, () => stores.graphStore.readChains());

/** Read-only graph snapshot for GET /api/graph: home and practice use it
 * while agent tools read the same graph store. Extraction writes separately. */
export function graphView(): GraphSnapshot {
	let sources: NotesSource[] | undefined;
	const organization = stores.sourceOrganizationStore.read();
	const names = organization.names;
	return graphSnapshot({
		...stores,
		graphStore: {
			...stores.graphStore,
			readNodes,
			readChains,
			readSources: () => (sources ??= stores.graphStore.readSources()),
		},
	}, names);
}

/** Cost data for the home knowledge summary, folded from extraction runs
 * in chats and notes. Model prices are applied at read time. */
export function graphCosts(): GraphCostSummary {
	// Cost read (2026-10-31): listChats strips extraction logs. Read each
	// record once, keeping its projection guard and updatedAt order so
	// equal-time recent runs retain their old order.
	let chats: Array<{ title: string; extractions: ExtractionRunUsage[]; updatedAt: string }> = [];
	try {
		fs.mkdirSync(PATHS.chats, { recursive: true });
		for (const file of fs.readdirSync(PATHS.chats)) {
			if (!file.endsWith(".json")) continue;
			const record = stores.chatStore.getChat(file.slice(0, -5));
			if (!record) continue;
			try {
				phaseAt3Lh(record.messages);
				danglingQuestionOf(record.messages);
			} catch (err) {
				console.error(`[chat ${record.id}] summary projection failed:`, err);
				continue;
			}
			if (record.extractions?.length) {
				chats.push({ title: record.title ?? record.id, extractions: record.extractions, updatedAt: record.updatedAt });
			}
		}
		chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		chats = [];
	}
	const sources = stores.graphStore
		.readSources()
		.filter((s) => s.extractions?.length)
		.map((s) => ({ filePath: s.filePath, extractions: s.extractions! }));
	return graphCostSummary({ chats, sources }, callCost);
}

/** The graph's version stamp: the max mtime across its ledgers. Moves on
 * graph writes, never on reads; consumers poll it to detect changes. */
export function graphRevision(): number {
	let revision = 0;
	for (const file of [
		LEDGER_FILES.nodes,
		LEDGER_FILES.chains,
		LEDGER_FILES.sessions,
		LEDGER_FILES.coverage,
		POSITIONS_FILE,
	]) {
		try {
			revision = Math.max(revision, fs.statSync(file).mtimeMs);
		} catch {
			/* absent — nothing has ever written it */
		}
	}
	return revision;
}

// ─── single-node deletion (node interlude, owner-locked full-death) ──────────

/** What deleteGraphNode did — the route maps it straight to HTTP. */
export type NodeDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "extraction_running"; error: string }
	| { ok: true; stats: NodeDeletionStats; graphRevision: number };

/**
 * Delete one node by id — FULL DEATH (core/graph-deletion.ts for the
 * ledger semantics). The guard family is deliberately NOT the chat
 * one, and the reasoning is worth writing down:
 *
 *   - No turn/jobs gates. Turns and background jobs never write the
 *     graph ledgers; a turn's follow-up extraction registers as a run,
 *     and every code path here is synchronous — nothing can register
 *     or merge between the gate and the ledger rewrite (the event loop
 *     never yields inside this function).
 *   - THE EXTRACTION GATE — 409 while ANY pipeline run is registered,
 *     anywhere. A mid-flight run holds findings extracted from
 *     transcripts that predate the deletion; its merges could re-add
 *     aliases, provenance, or events to the dying node (the
 *     re-reference risk the dispatch flags). Unlike chat deletion we
 *     do NOT abort the run: it belongs to some session, and killing
 *     that session's spend is outside this deletion's blast radius —
 *     the UI retries once the dock drains. A run that starts AFTER
 *     the deletion is legitimate re-learning: it reads post-deletion
 *     ledgers, mints a fresh node for a re-taught topic, and
 *     mergeFindings ignores linkTo ids that no longer exist (the
 *     existingIds guard) — no dangling edges, no resurrection.
 */
export function deleteGraphNode(nodeId: string): NodeDeleteOutcome {
	if (extractionStatuses().length > 0) {
		return {
			ok: false,
			status: 409,
			code: "extraction_running",
			error: "An extraction is running — try again when it finishes",
		};
	}
	// THE SYNC BLOCK — no awaits below (the doc above): the gate and the
	// rewrite are one atomic stretch of the event loop.
	const stats = deleteNodeTraces(stores.graphStore, nodeId);
	if (stats === null) {
		return { ok: false, status: 404, code: "not_found", error: "No such node" };
	}
	return { ok: true, stats, graphRevision: graphRevision() };
}

