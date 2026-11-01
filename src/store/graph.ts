/**
 * GraphStore — the fs JSONL adapter: the append-only ledgers at
 * config.LEDGER_FILES (contracts.ts "v1 emission").
 *   nodes.jsonl     GraphNode        — one line per node write: the FIRST
 *                                      line for an id defines it; a later
 *                                      line with a REPEATED id is a
 *                                      link-append (session phrasings join
 *                                      aliases, provenance unions); reads
 *                                      merge by id (core/graph.ts getGraph)
 *   chains.jsonl    GraphChain       — one line per chain ASSERTION (a second
 *                                      session asserting the same
 *                                      (premises, conclusion) appends
 *                                      another line; readers merge)
 *   sessions.jsonl  SessionCheckpoint— emission checkpoints (foldedAt)
 *   coverage.jsonl  CoverageEntry    — per-message extraction coverage
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): there is NO edges ledger — the edge
 * view (implication nodes + untyped arrows) is derived in core/graph.ts on
 * every read and never persisted. A stale edges.jsonl left by a pre-chains
 * build is deleted once, here, at adapter load (same doctrine as the
 * events-ledger purge below).
 *
 * Plus config.SOURCES_FILE (sources.json): the imported-notes bookkeeping
 * (NOT a ledger) — one JSON map, src-id → NotesSource, read-modify-write
 * like a chat file. The format-agnostic front door (2026-09-13).
 *
 * Implements core/ports.ts GraphStore. data/graph/* is exclusively this
 * adapter's. Reads are strict against the contracts.ts shapes (the 2026-09-02
 * graph redesign): corrupt lines are skipped, never guessed at — the ledgers
 * are the source of truth and everything else is derived (core/graph.ts,
 * which takes this port as a parameter). Same idioms as src/store/chats.ts:
 * sync fs, no framework.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LEDGER_FILES, POSITIONS_FILE, SOURCES_FILE } from "../../config.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { fsyncDirectory, isMissingFile, writeAtomicFile } from "./atomic-file.ts";
import type {
	GraphChain,
	GraphNode,
	ExtractionRunUsage,
	NotesSource,
	ProvenancePoint,
	CoverageEntry,
	SessionCheckpoint,
	Position,
} from "../core/contracts.ts";
import type { GraphStore } from "../core/ports.ts";

// ─── JSONL primitives ────────────────────────────────────────────────────────

// A committed rewrite journal replays an interrupted multi-ledger deletion.
const REWRITE_JOURNAL = path.join(path.dirname(LEDGER_FILES.nodes), "rewrite-pending.json");
const ledgerPaths = {
	nodes: LEDGER_FILES.nodes,
	chains: LEDGER_FILES.chains,
	coverage: LEDGER_FILES.coverage,
	checkpoints: LEDGER_FILES.sessions,
} as const;

function recoverPendingRewrite(): void {
	let raw: string;
	try {
		raw = fs.readFileSync(REWRITE_JOURNAL, "utf-8");
	} catch (err) {
		if (isMissingFile(err)) return;
		throw err;
	}
	const pending: unknown = JSON.parse(raw);
	if (typeof pending !== "object" || pending === null || Array.isArray(pending))
		throw new Error(`Invalid graph rewrite journal: ${REWRITE_JOURNAL}`);
	for (const [key, records] of Object.entries(pending)) {
		if (!(key in ledgerPaths) || !Array.isArray(records))
			throw new Error(`Invalid graph rewrite journal: ${REWRITE_JOURNAL}`);
		const body = records.map((record: unknown) => JSON.stringify(record)).join("\n");
		writeAtomicFile(ledgerPaths[key as keyof typeof ledgerPaths], body ? `${body}\n` : "");
	}
	fs.unlinkSync(REWRITE_JOURNAL);
	fsyncDirectory(path.dirname(REWRITE_JOURNAL));
}

/** Scan backward in blocks so each append only checks the torn final line. */
function truncateTornTail(file: string): void {
	let fd: number;
	try {
		fd = fs.openSync(file, "r+");
	} catch (err) {
		if (isMissingFile(err)) return;
		throw err;
	}
	try {
		const size = fs.fstatSync(fd).size;
		if (size === 0) return;
		const last = Buffer.allocUnsafe(1);
		fs.readSync(fd, last, 0, 1, size - 1);
		if (last[0] === 10) return;
		const chunk = Buffer.allocUnsafe(4096);
		let end = size;
		while (end > 0) {
			const start = Math.max(0, end - chunk.length);
			const length = end - start;
			fs.readSync(fd, chunk, 0, length, start);
			const newline = chunk.lastIndexOf(10, length - 1);
			if (newline !== -1) {
				fs.ftruncateSync(fd, start + newline + 1);
				fs.fsyncSync(fd);
				return;
			}
			end = start;
		}
		fs.ftruncateSync(fd, 0);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function appendLine<T>(file: string, record: T): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	ensureGraphFormat(); // the lazy format stamp (graph-format.ts)
	recoverPendingRewrite();
	truncateTornTail(file);
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
}

function readRawLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch (err) {
		if (isMissingFile(err)) return []; // no ledger yet
		throw err;
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch (err) {
			console.error(`[graph-store] invalid JSONL in ${file}:`, err);
		}
	}
	return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Strict shape guards — anything not matching a W4 ledger shape is skipped. */
function readValid<T>(file: string, isValid: (v: unknown) => v is T): T[] {
	assertGraphFormat(); // honest refusal on a newer-stamped data dir
	recoverPendingRewrite();
	return readRawLines(file).filter((record) => {
		if (isValid(record)) return true;
		console.error(`[graph-store] invalid record in ${file}`);
		return false;
	}) as T[];
}

/** Provenance points are (chatId, messageId) pairs — message-granular. */
const isProvenancePoint = (v: unknown): v is ProvenancePoint =>
	isRecord(v) && isString(v.chatId) && isString(v.messageId);


const isGraphNode = (v: unknown): v is GraphNode =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

/** A chain line: premises ≥ 1 (a chain IS an argument — bare propositions
 *  ride the node ledger alone), every member a string, conclusion a string.
 *  Endpoint EXISTENCE is the derivation's concern (it drops dangling
 *  chains); the store only shapes. */
const isGraphChain = (v: unknown): v is GraphChain =>
	isRecord(v) &&
	isString(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isString) &&
	isString(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint) &&
	isString(v.createdAt);

const isCheckpoint = (v: unknown): v is SessionCheckpoint =>
	isRecord(v) && isString(v.chatId) && isString(v.foldedAt);

const isCoverageEntry = (v: unknown): v is CoverageEntry =>
	isRecord(v) && isString(v.chatId) && isString(v.fp) && typeof v.tokens === "number" && isString(v.foldedAt);

// ─── the port implementation ────────────────────────────────────────────────

export const graphStore: GraphStore = {
	appendNode(node: GraphNode): void {
		appendLine(LEDGER_FILES.nodes, node);
	},
	/** Raw node lines in append order. A node id may appear on more than
	 *  one line (a later session's LINK-append: phrasings + provenance); the
	 *  derivation (core/graph.ts getGraph) merges lines by id. */
	readNodes(): GraphNode[] {
		return readValid(LEDGER_FILES.nodes, isGraphNode);
	},

	/** Append one chain ASSERTION; readers merge lines by (premises,
	 *  conclusion). */
	appendChain(assertion: GraphChain): void {
		appendLine(LEDGER_FILES.chains, assertion);
	},
	readChains(): GraphChain[] {
		return readValid(LEDGER_FILES.chains, isGraphChain);
	},

	appendCheckpoint(checkpoint: SessionCheckpoint): void {
		appendLine(LEDGER_FILES.sessions, checkpoint);
	},
	readCheckpoints(): SessionCheckpoint[] {
		return readValid(LEDGER_FILES.sessions, isCheckpoint);
	},

	appendCoverage(entry: CoverageEntry): void {
		appendLine(LEDGER_FILES.coverage, entry);
	},
	readCoverage(): CoverageEntry[] {
		return readValid(LEDGER_FILES.coverage, isCoverageEntry);
	},

	// ── imported-notes bookkeeping (config.SOURCES_FILE — a JSON map) ──

	/** Upsert: keeps the existing record's usage log when re-importing, and
	 *  its vault sync state (fork, 2026-11-01) unless the caller sends one —
	 *  the extraction pipeline's metadata write must not unlink a vault note.
	 *  A vault note also keeps its first-seen `importedAt`: re-extracting an
	 *  edit must not redate the row. */
	upsertSource(source: NotesSource): void {
		const all = readSourceMap();
		const prev = all[source.id];
		const vault = source.vault ?? prev?.vault;
		all[source.id] = prev
			? { ...source, extractions: prev.extractions, ...(vault ? { vault, importedAt: prev.importedAt } : {}) }
			: source;
		writeSourceMap(all);
	},
	readSources(): NotesSource[] {
		return Object.values(readSourceMap());
	},
	deleteSources(ids: ReadonlySet<string>): number {
		if (ids.size === 0) return 0;
		const all = readSourceMap();
		let removed = 0;
		for (const id of ids) if (Object.hasOwn(all, id)) { delete all[id]; removed++; }
		if (removed === 0) return 0;
		const tmp = `${SOURCES_FILE}.tmp-${crypto.randomUUID()}`;
		try {
			fs.writeFileSync(tmp, JSON.stringify(all, null, "\t"), "utf-8");
			fs.renameSync(tmp, SOURCES_FILE);
		} finally {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
		}
		return removed;
	},
	/** Idempotent per startedAt — same discipline as chats.appendExtractionUsage. */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): void {
		const all = readSourceMap();
		const source = all[id];
		if (!source) return; // no such source — nothing to bill against
		source.extractions = source.extractions?.some((r) => r.startedAt === entry.startedAt)
			? source.extractions
			: [...(source.extractions ?? []), entry];
		writeSourceMap(all);
	},

	// The layout ledger is a whole-record map, not a JSONL evidence stream.
	readPositions(): Record<string, Position> {
		assertGraphFormat();
		let raw: string;
		try {
			raw = fs.readFileSync(POSITIONS_FILE, "utf-8");
		} catch (err) {
			if (isMissingFile(err)) return {};
			throw err;
		}
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("positions" in parsed))
			throw new Error(`Invalid graph positions record: ${POSITIONS_FILE}`);
		const values = parsed.positions;
		if (typeof values !== "object" || values === null || Array.isArray(values))
			throw new Error(`Invalid graph positions record: ${POSITIONS_FILE}`);
		const positions: Record<string, Position> = {};
		for (const [id, value] of Object.entries(values)) {
			if (!isRecord(value) || typeof value.x !== "number" || !Number.isFinite(value.x)
				|| typeof value.y !== "number" || !Number.isFinite(value.y)) continue;
			positions[id] = { x: value.x, y: value.y };
		}
		return positions;
	},
	writePositions(positions: Record<string, Position>): void {
		ensureGraphFormat();
		writeAtomicFile(POSITIONS_FILE, JSON.stringify({ positions, updatedAt: new Date().toISOString() }, null, "\t"));
	},

	/** THE DESTRUCTIVE SEAM (wave 6 session deletion): commit the complete
	 *  intended rewrite to a durable journal before replacing any ledger.
	 *  A crash between ledger renames replays the transaction on the next
	 *  read or append, rather than leaving half the deleted chat's graph.
	 *  Each file replacement is atomic and fsynced. */
	rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
	}): void {
		ensureGraphFormat();
		recoverPendingRewrite();
		writeAtomicFile(REWRITE_JOURNAL, JSON.stringify(next));
		recoverPendingRewrite();
	},
};

/** sources.json — { id: NotesSource }. Read-modify-write, NOT append-only:
 *  the usage log lives inside the record (like a chat's JSON file). */
function readSourceMap(): Record<string, NotesSource> {
	assertGraphFormat(); // honest refusal on a newer-stamped data dir
	let raw: string;
	try {
		raw = fs.readFileSync(SOURCES_FILE, "utf-8");
	} catch (err) {
		if (isMissingFile(err)) return {};
		throw err;
	}
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed) || Array.isArray(parsed)) throw new Error(`Invalid graph sources record: ${SOURCES_FILE}`);
	const out: Record<string, NotesSource> = {};
	for (const [id, value] of Object.entries(parsed)) {
		if (!isNotesSource(value)) throw new Error(`Invalid graph source ${id} in ${SOURCES_FILE}`);
		out[id] = value;
	}
	return out;
}

function writeSourceMap(map: Record<string, NotesSource>): void {
	ensureGraphFormat(); // the lazy format stamp (graph-format.ts)
	writeAtomicFile(SOURCES_FILE, JSON.stringify(map, null, "\t"));
}

// ─── one-way purges at adapter load: dead ledgers are exactly the confusion
// the cleanup removes (owner doctrine — nothing reads them, nothing writes
// them, a stale file lying around is a lie). ────────────────────────────────
{
	const graphDir = path.dirname(LEDGER_FILES.nodes);
	for (const legacy of ["edges.jsonl", "events.jsonl"]) {
		const file = path.join(graphDir, legacy);
		try {
			if (fs.existsSync(file)) {
				fs.rmSync(file);
				console.info(`[graph-store] purged legacy ledger: ${file}`);
			}
		} catch (err) {
			console.warn(`[graph-store] could not purge legacy ledger ${file}:`, err);
		}
	}
}

const isNotesSource = (v: unknown): v is NotesSource =>
	isRecord(v) && isString(v.id) && isString(v.filePath) && isString(v.importedAt);
