import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { VAULT_DIR } from "../../config.ts";
import type { NotesSource } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import { detachSourceTraces, pruneDetachedNodes } from "../core/graph-deletion.ts";
import { extraction } from "./chat-handler.ts";
import { stores } from "./stores.ts";
import { libraryPreferences, syncVault, vaultExtracting } from "./vault.ts";

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
	extracting: string | null;
	draining: boolean;
}

const followed = (): NotesSource[] => stores.graphStore.readSources().filter((s) => s.vault);
export const vaultNoteWaiting = (s: NotesSource): boolean =>
	!!s.vault && !s.vault.missingSince && s.vault.contentHash !== s.vault.extractedHash;

let draining: Promise<void> | null = null;

export function libraryStatus(): LibraryStatus {
	const sources = followed();
	const { autoExtract, exclude } = libraryPreferences();
	return {
		enabled: VAULT_DIR !== null,
		autoExtract,
		exclude,
		notes: sources.filter((s) => !s.vault!.missingSince).length,
		waiting: sources.filter(vaultNoteWaiting).length,
		missing: sources.filter((s) => s.vault!.missingSince).length,
		extracting: vaultExtracting.id,
		draining: draining !== null,
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
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[library] ${vault.path}: extraction failed`, err);
		patchVault(source.id, (v) => ({ ...v, lastError: message }));
	} finally {
		vaultExtracting.id = null;
		emit("sources-changed", {});
	}
}

/** Drain waiting notes. "manual" ignores the quiet period. A drain already
 * running absorbs the request (it re-reads the waiting list each note). */
export function drainLibrary(mode: "manual" | "auto"): Promise<void> {
	if (!VAULT_DIR) return Promise.resolve();
	draining ??= (async () => {
		try {
			await syncVault();
			const tried = new Set<string>();
			for (;;) {
				const now = Date.now();
				const next = followed().find((s) => vaultNoteWaiting(s) && !tried.has(s.id)
					&& (mode === "manual" || now - Date.parse(s.vault!.changedAt) >= QUIET_MS));
				if (!next) return;
				tried.add(next.id); // one attempt per note per drain: a failure must not spin
				await extractNote(next);
			}
		} finally {
			draining = null;
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
	const tick = async () => {
		await syncVault();
		if (libraryPreferences().autoExtract) await drainLibrary("auto");
	};
	void tick();
	setInterval(() => { void tick(); }, POLL_MS).unref();
}
