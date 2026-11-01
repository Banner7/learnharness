import { deleteSourcesTraces, pruneDetachedNodes } from "../core/graph-deletion.ts";
import type { SourceDirectory } from "../core/source-organization.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { stores } from "./stores.ts";
import { sourceDirectory } from "./source-organization.ts";
import { deleteIdleChatRecord, runningWorkBlocker } from "./chats.ts";
import { graphRevision } from "./graph.ts";

export class SourceDeletionError extends Error {
	constructor(message: string, public status = 400, public code = "invalid_source_deletion") { super(message); }
}
export interface SourceDeletionRequest { sourceIds: string[]; deleteSessions: boolean }
function parseSourceDeletion(raw: unknown): SourceDeletionRequest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SourceDeletionError("Invalid source deletion request.");
	const r = raw as Record<string, unknown>;
	const ids = (value: unknown) => {
		if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) throw new SourceDeletionError("Source IDs must be an array of non-empty strings.");
		return [...new Set(value)] as string[];
	};
	if (typeof r.deleteSessions !== "boolean") throw new SourceDeletionError("Session deletion must be explicitly selected or declined.");
	const result = { sourceIds: ids(r.sourceIds), deleteSessions: r.deleteSessions };
	if (!result.sourceIds.length) throw new SourceDeletionError("Select at least one source.");
	return result;
}

/** A single synchronous deletion stretch, after the same global extraction
 * refusal as the old chains-view deletion. No imports or turns are cancelled.
 * Missing entries are harmless on retry after a partially completed I/O failure. */
export function deleteSources(raw: unknown): SourceDirectory & { graphRevision: number } {
	const request = parseSourceDeletion(raw);
	const directory = sourceDirectory.read(); // validate organization before any destructive write
	const targets = directory.sources.filter((s) => request.sourceIds.includes(s.id));
	if (targets.length && extractionStatuses().length) throw new SourceDeletionError("An extraction is running — try again when the activity dock drains.", 409, "extraction_running");
	// Vault library (fork, 2026-11-01): a followed note that still exists
	// would reappear on the next scan and re-extract — the vault decides.
	// Only a note already gone from the vault (state "missing") or one on the
	// skip list (state "skipped" — outside what LH follows) deletes here.
	const present = targets.filter((s) => s.vault !== undefined && s.vault !== "missing" && s.vault !== "skipped");
	if (present.length) throw new SourceDeletionError(`${present.map((s) => s.label).join(", ")} ${present.length === 1 ? "is" : "are"} still in your vault. Delete or skip ${present.length === 1 ? "it" : "them"} there.`, 409, "vault_note_present");
	if (request.deleteSessions) for (const entry of targets) if (entry.kind === "chat") {
		const blocker = runningWorkBlocker(entry.id);
		if (blocker) throw new SourceDeletionError(blocker.error, blocker.status, blocker.code);
	}
	// Clear the whole selected batch in one graph rewrite. Kept chats lose
	// coverage/checkpoints too, so their unchanged messages can be re-extracted.
	const targetIds = new Set(targets.map((s) => s.id));
	deleteSourcesTraces(stores.graphStore, targetIds, "delete-nodes");
	// (fork, 2026-11-01): after a failed re-extraction a note's old ideas are
	// detached — no provenance, listed only in vault.detached. Deleting the
	// record would orphan them forever, so prune them first, reading the raw
	// records before deleteSources removes them.
	const pending = stores.graphStore.readSources().filter((s) => targetIds.has(s.id)).flatMap((s) => s.vault?.detached ?? []);
	if (pending.length) pruneDetachedNodes(stores.graphStore, new Set(pending));
	stores.graphStore.deleteSources(new Set(targets.filter((s) => s.kind === "notes").map((s) => s.id)));
	const removed = new Set(request.sourceIds.filter((id) => !directory.sources.some((s) => s.id === id)));
	for (const entry of targets) {
		if (entry.kind === "chat" && request.deleteSessions) {
			const outcome = deleteIdleChatRecord(entry.id);
			if (!outcome.ok) throw new SourceDeletionError(outcome.error, outcome.status, outcome.code);
			removed.add(entry.id);
		} else if (entry.kind !== "chat") removed.add(entry.id);
	}
	// Drop display names for removed sources; keep everything else intact.
	const stored = stores.sourceOrganizationStore.read();
	const names = Object.fromEntries(Object.entries(stored.names).filter(([id]) => !removed.has(id)));
	if (Object.keys(names).length !== Object.keys(stored.names).length) stores.sourceOrganizationStore.write({ ...stored, names });
	return { ...sourceDirectory.read(), graphRevision: graphRevision() };
}
