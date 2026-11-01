import type { NotesSource } from "./contracts.ts";
import { vaultPathExcluded } from "./vault-sync.ts";

/** Source organization is presentation metadata only, never graph/extraction
 * identity. Folders and drag-and-drop are retired (owner, 2026-11-01): the
 * sole stored fact is a per-source display name for uploaded files. Chats
 * keep their titles in ChatStore; vault notes are named by the vault. */
export interface SourceOrganization {
	version: 2;
	/** Uploaded non-vault source display names, keyed by source id. */
	names: Record<string, string>;
}
export interface SourceEntry {
	id: string;
	kind: "chat" | "notes" | "missing";
	label: string | null;
	createdAt: string | null;
	filePath?: string;
	/** Vault library (fork, 2026-11-01): present only for followed notes. */
	vault?: VaultEntryState;
	/** The note's vault-relative path (followed notes only); the tree derives
	 *  its read-only virtual folders from these paths. */
	vaultPath?: string;
	/** ISO — set only while the note is absent from the vault. */
	missingSince?: string;
	/** A missing note's impact (server-computed, one pass): ideas whose
	 *  provenance includes it, and of those, ideas ONLY this note supports. */
	ideas?: number;
	onlyFromThisNote?: number;
}
/** ready: the graph reflects the file · waiting: new or edited, not yet
 *  extracted · extracting: running now · failed: the last run failed (still
 *  waiting; retried by the next sync) · missing: gone from the vault ·
 *  skipped: still there but on the skip list (owner, 2026-11-01: "skipped",
 *  not "missing" — derived from the live list, so un-skipping restores it
 *  exactly like a note coming back). */
export type VaultEntryState = "ready" | "waiting" | "extracting" | "failed" | "missing" | "skipped";
export function vaultEntryState(source: NotesSource, extractingId: string | null, exclude: readonly string[] = []): VaultEntryState {
	const vault = source.vault!;
	if (vault.missingSince) return vaultPathExcluded(vault.path, exclude) ? "skipped" : "missing";
	if (source.id === extractingId) return "extracting";
	if (vault.contentHash === vault.extractedHash) return "ready";
	return vault.lastError ? "failed" : "waiting";
}

export interface SourceDirectory {
	sources: SourceEntry[];
}

export const emptySourceOrganization = (): SourceOrganization => ({ version: 2, names: {} });
export const sourceName = (state: SourceOrganization, id: string): string | undefined =>
	Object.hasOwn(state.names, id) ? state.names[id] : undefined;

/** Reject unsupported/corrupt data rather than overwrite organization on a
 * write. Version 1 (the pre-fork folders/placements shape) is tolerated at
 * read and migrated: per-source display names survive, folders and folderId
 * are dropped — the next write saves version 2 (owner, 2026-11-01). */
export function parseSourceOrganization(raw: unknown): SourceOrganization {
	const fail = (): never => { throw new Error("Could not read source organization. Its data is invalid or newer than this app."); };
	if (!raw || typeof raw !== "object") return fail();
	const r = raw as Partial<SourceOrganization> & { folders?: unknown; placements?: Record<string, { name?: unknown }> };
	if (r.version === 2) {
		if (!r.names || typeof r.names !== "object" || Array.isArray(r.names)) return fail();
		for (const name of Object.values(r.names)) if (typeof name !== "string" || !name.trim()) return fail();
		return { version: 2, names: r.names };
	}
	if (r.version === 1 && r.placements && typeof r.placements === "object" && !Array.isArray(r.placements)) {
		const names: Record<string, string> = {};
		for (const [id, p] of Object.entries(r.placements)) {
			if (p && typeof p === "object" && typeof p.name === "string" && p.name.trim()) names[id] = p.name;
		}
		return { version: 2, names };
	}
	return fail();
}
