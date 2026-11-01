import type { NotesSource } from "./contracts.ts";

/**
 * Vault library reconcile (fork, 2026-11-01): the vault is the library and
 * LH follows it — no import step. Pure: the server scans the directory and
 * hands the file list in; this decides which source records change.
 *
 * Identity: a vault source's id is opaque and minted once, so a rename keeps
 * its graph. A file at a path no source follows is matched to a vanished
 * source with byte-identical content (a rename or move) before a new source
 * is minted. A followed file that vanished is marked missing, never deleted:
 * a Syncthing accident must not wipe ideas without the learner confirming.
 * Sources without `vault` (uploads, chats) are never touched.
 */
export interface VaultFile {
	/** Vault-relative POSIX path. */
	path: string;
	/** sha256 hex of the file bytes. */
	hash: string;
}

export interface VaultReconcile {
	/** Records to write (new, renamed, edited, gone or returned). */
	upserts: NotesSource[];
	created: number;
	renamed: number;
	changed: number;
	missing: number;
	restored: number;
}

export function reconcileVault(
	sources: readonly NotesSource[],
	files: readonly VaultFile[],
	now: string,
	newId: () => string,
): VaultReconcile {
	const result: VaultReconcile = { upserts: [], created: 0, renamed: 0, changed: 0, missing: 0, restored: 0 };
	const followed = sources.filter((s) => s.vault);
	const byPath = new Map(followed.map((s) => [s.vault!.path, s]));
	const present = new Set(files.map((f) => f.path));
	// Rename candidates: followed sources whose path no longer exists.
	const vanished = followed.filter((s) => !present.has(s.vault!.path));
	const claimed = new Set<string>();
	const unmatched: VaultFile[] = [];

	for (const file of files) {
		const source = byPath.get(file.path);
		if (!source) { unmatched.push(file); continue; }
		const vault = source.vault!;
		if (vault.contentHash === file.hash && !vault.missingSince) continue;
		const next = { ...vault };
		if (vault.missingSince) { delete next.missingSince; result.restored++; }
		if (vault.contentHash !== file.hash) {
			next.contentHash = file.hash;
			next.changedAt = now;
			delete next.lastError; // new bytes deserve a fresh attempt
			result.changed++;
		}
		result.upserts.push({ ...source, vault: next });
	}

	for (const file of unmatched) {
		// Only an unambiguous byte-identical match counts as a move; two
		// vanished copies of the same text leave the file a new source.
		const matches = vanished.filter((s) => !claimed.has(s.id) && s.vault!.contentHash === file.hash);
		if (matches.length === 1) {
			const source = matches[0]!;
			claimed.add(source.id);
			const next = { ...source.vault!, path: file.path };
			delete next.missingSince;
			result.upserts.push({ ...source, filePath: file.path, vault: next });
			result.renamed++;
			continue;
		}
		result.upserts.push({
			id: newId(),
			filePath: file.path,
			importedAt: now,
			vault: { path: file.path, contentHash: file.hash, changedAt: now },
		});
		result.created++;
	}

	for (const source of vanished) {
		if (claimed.has(source.id) || source.vault!.missingSince) continue;
		result.upserts.push({ ...source, vault: { ...source.vault!, missingSince: now } });
		result.missing++;
	}
	return result;
}

/** Exclusion: a pattern ending in "/" excludes that folder and everything
 * under it, matched from the vault root; otherwise it excludes one exact
 * vault-relative path. Dot-folders (.obsidian, .stfolder, .trash) are
 * always excluded by the scanner.
 *
 * Globs (owner ruling, 2026-11-01): a pattern containing `*` or `?` is a
 * glob — `*` and `?` stay inside one path segment, `**` crosses folders
 * (`**` + `/` also matches zero folders). Plain lines keep their exact
 * meaning, so saved skip lists behave as before: `**` + `/Templates/` skips
 * Templates at any depth, `*.excalidraw.md` only at the root. */
export function vaultPathExcluded(path: string, exclude: readonly string[]): boolean {
	return exclude.some((pattern) => {
		if (!/[*?]/.test(pattern)) return pattern.endsWith("/") ? path.startsWith(pattern) : path === pattern;
		return globRegex(pattern).test(path);
	});
}

const globCache = new Map<string, RegExp>();
function globRegex(pattern: string): RegExp {
	let re = globCache.get(pattern);
	if (re) return re;
	const folder = pattern.endsWith("/");
	const body = folder ? pattern.slice(0, -1) : pattern;
	let src = "";
	for (let i = 0; i < body.length; i++) {
		const c = body[i]!;
		if (c === "*" && body[i + 1] === "*") {
			if (body[i + 2] === "/") { src += "(?:.*/)?"; i += 2; } else { src += ".*"; i += 1; }
		} else if (c === "*") src += "[^/]*";
		else if (c === "?") src += "[^/]";
		else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	// A folder glob matches that folder's path as a prefix (everything under
	// it); a file glob must match the whole path.
	re = new RegExp(folder ? `^${src}/` : `^${src}$`);
	globCache.set(pattern, re);
	return re;
}

/** LH_VAULT_EXCLUDE: comma-separated patterns, whitespace-trimmed, empties dropped. */
export function parseVaultExclude(raw: string | undefined): string[] {
	return (raw ?? "").split(",").map((p) => p.trim().replace(/^\/+/, "")).filter(Boolean);
}
