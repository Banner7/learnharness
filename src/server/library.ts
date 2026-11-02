import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { VAULT_DIR } from "../../config.ts";
import type { NotesSource } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import { detachSourceTraces, pruneDetachedNodes } from "../core/graph-deletion.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { extraction } from "./chat-handler.ts";
import { stores } from "./stores.ts";
import { libraryPreferences, syncVault, vaultExtracting } from "./vault.ts";
import { vaultEntryState } from "../core/source-organization.ts";

/**
 * The vault library's extraction side (fork, 2026-11-01). Notes whose
 * bytes differ from what the graph reflects are WAITING; "Sync now" drains
 * them all, auto-extract (off by default) drains only notes quiet for five
 * minutes — Obsidian saves while typing and the sync tool pushes every
 * save, so a note mid-edit must not burn a run per keystroke burst.
 *
 * One drain at a time, notes in sequence: the pipeline already caps model
 * concurrency, and serializing keeps the detach → re-extract → prune
 * stretch of one note from interleaving with another note's.
 */
const QUIET_MS = 5 * 60_000;
const POLL_MS = 30_000;

export interface LibraryStatus {
	enabled: boolean;
	autoExtract: boolean;
	exclude: string[];
	notes: number;
	waiting: number;
	missing: number;
	skipped: number;
	extracting: string | null;
	draining: boolean;
	/** Why the last drain stopped before extracting anything (models or a
	 *  provider key missing); cleared by the next drain that gets going. */
	blocked: string | null;
}

const followed = (): NotesSource[] => stores.graphStore.readSources().filter((s) => s.vault);
const vaultNoteWaiting = (s: NotesSource): boolean =>
	!!s.vault && !s.vault.missingSince && s.vault.contentHash !== s.vault.extractedHash;

let draining: Promise<void> | null = null;
/** A "Sync now" that arrives while an auto drain runs widens that drain to
 *  notes still inside their quiet period (it re-checks on every pick). */
let manualRequested = false;
let blocked: string | null = null;
const isSetupRefusal = (err: unknown): boolean =>
	err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError;

export function libraryStatus(): LibraryStatus {
	const sources = followed();
	const { autoExtract, exclude } = libraryPreferences();
	return {
		enabled: VAULT_DIR !== null,
		autoExtract,
		exclude,
		notes: sources.filter((s) => !s.vault!.missingSince).length,
		waiting: sources.filter(vaultNoteWaiting).length,
		missing: sources.filter((s) => vaultEntryState(s, null, exclude) === "missing").length,
		skipped: sources.filter((s) => vaultEntryState(s, null, exclude) === "skipped").length,
		extracting: vaultExtracting.id,
		draining: draining !== null,
		blocked,
	};
}

/** Write vault state onto the FRESH record (a scan may have moved the file
 * while the run was in flight); a source deleted meanwhile stays deleted. */
function patchVault(id: string, patch: (vault: NonNullable<NotesSource["vault"]>) => NotesSource["vault"]): void {
	const fresh = stores.graphStore.readSources().find((s) => s.id === id);
	if (fresh?.vault) stores.graphStore.upsertSource({ ...fresh, vault: patch(fresh.vault) });
}

async function extractNote(source: NotesSource): Promise<void> {
	const vault = source.vault!;
	let bytes: Buffer;
	try { bytes = await fs.promises.readFile(path.join(VAULT_DIR!, vault.path)); }
	catch { return; } // gone since the scan — the next scan marks it missing
	const hash = createHash("sha256").update(bytes).digest("hex");
	// Refuse BEFORE detaching (review, 2026-11-01): a run that cannot start
	// must leave the note's chains and coverage exactly as they were.
	extraction.assertReady();
	vaultExtracting.id = source.id;
	emit("sources-changed", {});
	try {
		// Detach is idempotent and also covers a first run that merged some
		// chunks before failing; earlier unpruned candidates carry over.
		const detached = new Set([...(vault.detached ?? []), ...detachSourceTraces(stores.graphStore, source.id)]);
		patchVault(source.id, (v) => ({ ...v, detached: [...detached] }));
		await extraction.extractVaultNote({ id: source.id, filePath: vault.path, text: bytes.toString("utf-8") });
		const pruned = pruneDetachedNodes(stores.graphStore, detached);
		if (pruned > 0) console.info(`[library] ${vault.path}: pruned ${pruned} idea(s) the note no longer supports`);
		patchVault(source.id, (v) => {
			const { detached: _done, lastError: _cleared, ...rest } = v;
			return { ...rest, extractedHash: hash };
		});
	} catch (err) {
		if (isSetupRefusal(err)) throw err; // a setup problem, not this note's
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[library] ${vault.path}: extraction failed: ${message}`);
		patchVault(source.id, (v) => ({ ...v, lastError: message }));
	} finally {
		vaultExtracting.id = null;
		emit("sources-changed", {});
	}
}

/** Drain waiting notes. "manual" ignores the quiet period and retries
 * failed notes; "auto" takes quiet notes that have not failed on their
 * current bytes (a failure would otherwise re-run, and bill, every poll).
 * A setup refusal stops the drain and is reported once via `blocked`. */
export function drainLibrary(mode: "manual" | "auto"): Promise<void> {
	if (!VAULT_DIR) return Promise.resolve();
	if (mode === "manual") manualRequested = true;
	draining ??= (async () => {
		try {
			await syncVault();
			const tried = new Set<string>();
			for (;;) {
				const now = Date.now();
				const next = followed().find((s) => vaultNoteWaiting(s) && !tried.has(s.id)
					&& (manualRequested || (!s.vault!.lastError && now - Date.parse(s.vault!.changedAt) >= QUIET_MS)));
				if (!next) return;
				tried.add(next.id); // one attempt per note per drain: a failure must not spin
				try {
					await extractNote(next);
					blocked = null;
				} catch (err) {
					if (!isSetupRefusal(err)) throw err;
					blocked = (err as Error).message;
					console.info(`[library] sync stopped: ${blocked}`);
					return;
				}
			}
		} finally {
			draining = null;
			manualRequested = false;
			emit("sources-changed", {});
		}
	})();
	return draining;
}

/** Boot hook: an immediate scan, then a light poll; auto-extract rides the
 * poll when switched on. No-op without LH_VAULT_DIR. */
export function startVaultFollower(): void {
	if (!VAULT_DIR) return;
	console.info(`[vault] following ${VAULT_DIR}`);
	// Tick guard (audit fix, 2026-11-03): a failed scan/drain must log, not
	// reject unhandled and kill the server.
	const tick = async () => {
		try {
			await syncVault();
			if (libraryPreferences().autoExtract) await drainLibrary("auto");
		} catch (err) {
			console.error("[vault] follower tick failed:", err);
		}
	};
	void tick();
	setInterval(() => { void tick(); }, POLL_MS).unref();
}
