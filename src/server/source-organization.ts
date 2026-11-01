import { stores } from "./stores.ts";
import type { ChatStore, GraphStore, SourceOrganizationStore } from "../core/ports.ts";
import { getGraph } from "../core/graph.ts";
import { sourceFileLabel } from "../core/source-label.ts";
import {
	sourceName, vaultEntryState,
	type SourceDirectory, type SourceEntry,
} from "../core/source-organization.ts";
import { libraryPreferences, vaultExtracting } from "./vault.ts";

export class SourceOrganizationInputError extends Error {}

function createSourceDirectory(deps: { chatStore: ChatStore; graphStore: GraphStore; sourceOrganizationStore: SourceOrganizationStore }) {
	function read(): SourceDirectory {
		const organization = deps.sourceOrganizationStore.read();
		const entries = new Map<string, SourceEntry>();
		for (const c of deps.chatStore.listChats()) entries.set(c.id, { id: c.id, kind: "chat", label: c.title, createdAt: c.createdAt });
		// One sources read and one skip-list read per directory view (fork,
		// 2026-11-01). The merged graph below feeds both the missing-note idea
		// counts and the missing-provenance loop.
		const graph = getGraph(deps.graphStore);
		const sources = deps.graphStore.readSources();
		const exclude = libraryPreferences().exclude;
		// Missing-note impact (owner, 2026-11-01): one pass over the merged
		// graph tallies, per source, how many ideas its provenance includes
		// and how many ONLY it supports. Distinct chatIds on one node are its
		// backing sources; a single distinct source means the idea is that
		// source's alone.
		const ideas = new Map<string, number>();
		const only = new Map<string, number>();
		for (const node of graph.nodes) {
			const distinct = new Set(node.provenance.map((p) => p.chatId));
			for (const id of distinct) ideas.set(id, (ideas.get(id) ?? 0) + 1);
			if (distinct.size === 1) for (const id of distinct) only.set(id, (only.get(id) ?? 0) + 1);
		}
		for (const s of sources) {
			const missing = s.vault?.missingSince !== undefined;
			entries.set(s.id, {
				id: s.id, kind: "notes", label: sourceName(organization, s.id) ?? sourceFileLabel(s.filePath),
				filePath: s.filePath, createdAt: s.importedAt,
				...(s.vault ? { vault: vaultEntryState(s, vaultExtracting.id, exclude), vaultPath: s.vault.path } : {}),
				...(missing ? { missingSince: s.vault!.missingSince, ideas: ideas.get(s.id) ?? 0, onlyFromThisNote: only.get(s.id) ?? 0 } : {}),
			});
		}
		// Preserve graph groups whose naming record is gone; do not resurrect a chat.
		for (const node of graph.nodes) for (const p of node.provenance) {
			if (!entries.has(p.chatId)) entries.set(p.chatId, { id: p.chatId, kind: "missing", label: null, createdAt: null });
		}
		return { sources: [...entries.values()] };
	}
	/** The one surviving organization op (owner, 2026-11-01): rename an
	 * uploaded source or a chat. Vault notes are named by the vault. */
	function change(raw: unknown): SourceDirectory {
		let action: { action: "rename-source"; id: string; name: string };
		try {
			if (!raw || typeof raw !== "object") throw new Error();
			const r = raw as Record<string, unknown>;
			if (r.action !== "rename-source" || typeof r.id !== "string" || !r.id || typeof r.name !== "string" || !r.name.trim()) throw new Error();
			action = { action: "rename-source", id: r.id, name: r.name.trim() };
		} catch { throw new SourceOrganizationInputError("Invalid source rename."); }
		const directory = read();
		const entry = directory.sources.find((s) => s.id === action.id);
		if (!entry || entry.kind === "missing") throw new SourceOrganizationInputError("Source no longer exists.");
		if (entry.vault) throw new SourceOrganizationInputError("Vault notes are named by your vault. Rename them in Obsidian.");
		if (entry.kind === "chat") deps.chatStore.renameChat(entry.id, action.name);
		else {
			const state = deps.sourceOrganizationStore.read();
			state.names = { ...state.names, [entry.id]: action.name };
			deps.sourceOrganizationStore.write(state);
		}
		return read();
	}
	return { read, change };
}

export const sourceDirectory = createSourceDirectory(stores);

/** Bound actual JSON bytes as well as declared size; never buffer an unbounded
 * operation body. A cancelled tee must not delay the refusal. */
export async function readOrganizationAction(request: Request): Promise<unknown> {
	const limit = 64 * 1024;
	if (Number(request.headers.get("content-length")) > limit) {
		void request.body?.cancel().catch(() => undefined);
		throw new SourceOrganizationInputError("Source organization request is too large.");
	}
	const reader = request.body?.getReader();
	if (!reader) throw new SourceOrganizationInputError("Missing source organization action.");
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) throw new SourceOrganizationInputError("Source organization request is too large.");
			chunks.push(value);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		if (error instanceof SourceOrganizationInputError) throw error;
		throw new SourceOrganizationInputError("Could not read source organization action.");
	} finally {
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
