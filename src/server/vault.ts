import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { VAULT_DIR, VAULT_EXCLUDE_RAW } from "../../config.ts";
import { emit } from "../core/events.ts";
import { parseVaultExclude, reconcileVault, vaultPathExcluded, type VaultFile, type VaultReconcile } from "../core/vault-sync.ts";
import { parseWikilinkTargets } from "../core/wikilinks.ts";
import { readSettings } from "../store/settings.ts";
import { stores } from "./stores.ts";

/** Saved library settings win; LH_VAULT_EXCLUDE seeds the skip list until
 * the learner saves one. Auto-extract is off until switched on. */
export function libraryPreferences(): { autoExtract: boolean; exclude: string[] } {
	const library = readSettings()?.library;
	return {
		autoExtract: library?.autoExtract ?? false,
		exclude: library?.exclude ?? parseVaultExclude(VAULT_EXCLUDE_RAW),
	};
}

/** The vault source mid-extraction (set by library.ts), read by the source
 * directory for row state. Lives here so the directory need not import
 * the extraction pipeline. */
export const vaultExtracting = { id: null as string | null };

/**
 * The vault follower (fork, 2026-11-01): scans LH_VAULT_DIR for Markdown
 * notes and reconciles source records — no upload, no import button. The
 * vault is mounted read-only; nothing here ever writes inside it.
 *
 * Polling, not fs.watch: a sync tool replaces files by rename, recursive
 * watches drop events across bind mounts, and hashing a study vault every
 * 30 s costs milliseconds. The scan reads asynchronously; the reconcile and
 * its writes run in one synchronous stretch so no extraction write
 * interleaves between reading and writing the source map.
 */
async function walk(
	root: string,
	dir: string,
	exclude: readonly string[],
	priorHashes: ReadonlyMap<string, string>,
	out: VaultFile[],
): Promise<void> {
	let entries: fs.Dirent[];
	try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
	catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		const rel = path.relative(root, full).split(path.sep).join("/");
		if (entry.isDirectory()) {
			if (!vaultPathExcluded(`${rel}/`, exclude)) await walk(root, full, exclude, priorHashes, out);
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && !vaultPathExcluded(rel, exclude)) {
			let bytes: Buffer;
			// A file deleted between readdir and read is simply absent this scan.
			try { bytes = await fs.promises.readFile(full); } catch { continue; }
			const hash = createHash("sha256").update(bytes).digest("hex");
			// Parse wikilinks only when the bytes changed (owner, 2026-11-01):
			// unchanged notes keep their persisted raw targets — a fresh parse
			// every 30 s poll would redo work for no gain.
			const links = priorHashes.get(rel) === hash ? undefined : parseWikilinkTargets(bytes.toString("utf8"));
			out.push({ path: rel, hash, links });
		}
	}
}

async function scanVaultFiles(root: string, exclude: readonly string[], priorHashes: ReadonlyMap<string, string>): Promise<VaultFile[]> {
	const files: VaultFile[] = [];
	await walk(root, root, exclude, priorHashes, files);
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

let scanning: Promise<VaultReconcile | null> | null = null;
let rescan = false;

async function scanOnce(): Promise<VaultReconcile | null> {
	try {
		const root = VAULT_DIR!;
		await fs.promises.access(root, fs.constants.R_OK);
		// The previous scan's hashes decide what to re-parse (owner, 2026-11-01).
		const priorHashes = new Map(stores.graphStore.readSources()
			.filter((source) => source.vault !== undefined)
			.map((source) => [source.vault!.path, source.vault!.contentHash] as const));
		const files = await scanVaultFiles(root, libraryPreferences().exclude, priorHashes);
		const result = reconcileVault(stores.graphStore.readSources(), files, new Date().toISOString(),
			() => `src_${randomBytes(6).toString("hex")}`);
		for (const source of result.upserts) stores.graphStore.upsertSource(source);
		if (result.upserts.length > 0) {
			console.info(`[vault] ${result.created} new, ${result.renamed} moved, ${result.changed} edited, ${result.missing} missing, ${result.restored} back`);
			emit("sources-changed", {});
		}
		return result;
	} catch (err) {
		console.error("[vault] scan failed", err);
		return null;
	}
}

/** One scan + reconcile. Concurrent callers share the in-flight scan, and
 * a call arriving mid-scan queues exactly one more — a skip list saved
 * while an old-list scan runs still applies now, not a poll later. An
 * unreadable vault root (unmounted, permissions) skips the reconcile rather
 * than marking every note missing. */
export function syncVault(): Promise<VaultReconcile | null> {
	if (!VAULT_DIR) return Promise.resolve(null);
	if (scanning) { rescan = true; return scanning; }
	scanning = (async () => {
		try {
			let result = await scanOnce();
			while (rescan) { rescan = false; result = await scanOnce(); }
			return result;
		} finally {
			scanning = null;
		}
	})();
	return scanning;
}
