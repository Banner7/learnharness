"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { fuzzyScore, type SourceDirectory } from "@/src/core";
import type { ChainSort } from "./chain-table";
import { chainRow } from "./chain-navigation";

/** The one surviving organization edit (owner, 2026-11-01): rename an
 * uploaded source or a chat. Vault notes are named by the vault. */
export type OrganizationChange = (action: { action: "rename-source"; id: string; name: string }) => Promise<string | void>;

/** Source labels are searchable, including sources without nodes. Folders are
 * virtual and read-only (owner, 2026-11-01), so only the label is matched. */
export function sourceNameMatches(label: string | null, query: string): boolean {
	if (!query.trim()) return true;
	return fuzzyScore(query, label ?? "") !== null;
}

/** Same Enter/blur commit and Escape cancel interaction as session titles.
 * The in-flight guard prevents Enter followed by blur from double-writing. */
export function EditableSourceName({ name, onSave, onCancel, initiallyEditing = false }: {
	name: string; onSave: (name: string) => Promise<unknown>; onCancel?: () => void; initiallyEditing?: boolean;
}) {
	const [editing, setEditing] = useState(initiallyEditing);
	const [draft, setDraft] = useState(name);
	const [failure, setFailure] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const submitting = useRef(false);
	const cancelled = useRef(false);
	useLayoutEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
	const commit = async () => {
		if (cancelled.current || submitting.current) return;
		const value = draft.trim();
		if (!value) { setEditing(false); onCancel?.(); return; }
		if (value === name && !initiallyEditing) { setEditing(false); return; }
		submitting.current = true;
		try { await onSave(value); setEditing(false); setFailure(""); }
		catch (error) { setFailure(error instanceof Error ? error.message : String(error)); input.current?.focus(); }
		finally { submitting.current = false; }
	};
	return <span className="min-w-0 flex-1">
		{editing ? <input ref={input} value={draft} placeholder="Source name" aria-label="Source name" data-testid="source-name-input"
			className="block h-5 w-full min-w-0 border-0 bg-transparent p-0 text-sm font-medium leading-5 outline-none shadow-none focus:ring-0"
			onChange={(e) => setDraft(e.target.value)} onBlur={() => { void commit(); }}
			onKeyDown={(e) => {
				if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelled.current = true; setEditing(false); setFailure(""); onCancel?.(); }
				if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void commit(); }
			}} />
			: <button type="button" className="block max-w-full truncate rounded-sm text-left text-sm font-medium leading-5 transition-colors hover:bg-accent" title="Rename"
				onClick={() => { cancelled.current = false; setDraft(name); setEditing(true); }}>{name}</button>}
		{failure && <span role="alert" className="block text-xs text-red-400">{failure}</span>}
	</span>;
}

interface TreeSource {
	key: string; birth: string | null; label: string | null; nodeIds: string[]; newestCreatedAt: string;
}

interface VaultFolderNode<T extends TreeSource> {
	name: string;
	path: string;
	sources: T[];
	children: VaultFolderNode<T>[];
}

/** The chain table's tree (owner, 2026-11-01): only virtual vault folders
 * (derived read-only from note paths) plus two flat groups at the end —
 * Uploads (uploaded notes/PDF sources) and Chats. No drag, no editing of
 * folders; sources keep their checkbox + rename affordances via renderSource. */
export function SourceFolderTree<T extends TreeSource>({ groups, directory, query, sort, renderSource, expanded,
	onToggleExpanded, collapsedForSearch }: {
	groups: T[]; directory?: SourceDirectory; query: string; sort: ChainSort;
	renderSource: (source: T, depth: number) => ReactNode;
	expanded: ReadonlySet<string>; onToggleExpanded: (id: string) => void;
	collapsedForSearch?: ReadonlySet<string>;
}) {
	if (!directory) return <>{groups.map((g) => renderSource(g, 0))}</>;
	const search = query.trim() !== "";
	const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
	const entryOf = new Map(directory.sources.map((s) => [s.id, s]));
	const sortGroups = (list: T[]) => [...list].sort((a, b) => {
		const byName = collator.compare(a.label ?? "\uffff", b.label ?? "\uffff");
		return (sort.col === "name" ? byName : sort.col === "props" ? a.nodeIds.length - b.nodeIds.length : a.newestCreatedAt.localeCompare(b.newestCreatedAt)) * sort.dir || byName || a.key.localeCompare(b.key);
	});

	// Partition groups into their sections (vault notes by directory path,
	// then Uploads, Chats, and orphaned graph groups whose record is gone).
	const vaultNotes: T[] = [], uploads: T[] = [], chats: T[] = [], orphans: T[] = [];
	for (const g of groups) {
		const entry = g.birth ? entryOf.get(g.birth) : undefined;
		if (entry?.vaultPath) vaultNotes.push(g);
		else if (entry?.kind === "chat") chats.push(g);
		else if (entry?.kind === "notes") uploads.push(g);
		else orphans.push(g);
	}

	// Build the read-only vault folder tree from note paths.
	const vaultRoot: T[] = [];
	const vaultRoots: VaultFolderNode<T>[] = [];
	const byPath = new Map<string, VaultFolderNode<T>>();
	for (const note of vaultNotes) {
		const segments = (entryOf.get(note.birth!)?.vaultPath ?? "").split("/").slice(0, -1).filter(Boolean);
		if (segments.length === 0) { vaultRoot.push(note); continue; }
		let parent: VaultFolderNode<T> | null = null;
		for (let i = 0; i < segments.length; i++) {
			const path = segments.slice(0, i + 1).join("/");
			let folder = byPath.get(path);
			if (!folder) {
				folder = { name: segments[i]!, path, sources: [], children: [] };
				byPath.set(path, folder);
				if (parent) parent.children.push(folder);
				else vaultRoots.push(folder);
			}
			parent = folder;
		}
		parent!.sources.push(note);
	}
	vaultRoots.sort((a, b) => collator.compare(a.name, b.name));

	const folderCount = (folder: VaultFolderNode<T>): number => {
		const ids = new Set<string>();
		const walk = (f: VaultFolderNode<T>) => { for (const s of f.sources) for (const id of s.nodeIds) ids.add(id); for (const c of f.children) walk(c); };
		walk(folder);
		return ids.size;
	};

	const renderFolder = (folder: VaultFolderNode<T>, depth: number): ReactNode => {
		const open = search ? !collapsedForSearch?.has(folder.path) : expanded.has(folder.path);
		const children = [...folder.children].sort((a, b) => collator.compare(a.name, b.name));
		return <div key={folder.path} data-testid={`source-folder-${folder.path}`} className="relative">
			<div {...chainRow(["folder", folder.path], depth, open)} data-testid={`folder-row-${folder.path}`}
				className="flex items-center gap-1 border-b border-border py-1.5 pr-3" style={{ paddingLeft: 12 + depth * 36 }}>
				<button type="button" aria-expanded={open} aria-label={`Expand folder ${folder.name}`} data-testid={`folder-toggle-${folder.path}`}
					onClick={() => onToggleExpanded(folder.path)} className="flex h-5 w-3.5 shrink-0 items-center justify-center text-muted-foreground/70">
					<ChevronRightIcon className={`size-3.5 ${open ? "rotate-90" : ""}`} />
				</button>
				<button type="button" data-source-icon data-testid={`folder-icon-${folder.path}`} aria-expanded={open} aria-label={`Expand folder ${folder.name}`}
					onClick={() => onToggleExpanded(folder.path)} className="flex h-5 w-3.5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					{open ? <FolderOpenIcon className="size-3.5 shrink-0" /> : <FolderIcon className="size-3.5 shrink-0" />}
				</button>
				<span className="min-w-0 flex-1 truncate text-sm font-medium">{folder.name}</span>
				<span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{folderCount(folder)}</span>
				<span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground" />
			</div>
			{open && children.map((c) => renderFolder(c, depth + 1))}
			{open && sortGroups(folder.sources).map((g) => <div key={g.key}>{renderSource(g, depth + 1)}</div>)}
		</div>;
	};

	const renderFlatGroup = (title: string, items: T[], testid: string): ReactNode => {
		if (items.length === 0) return null;
		return <div key={title} data-testid={testid}>
			<div className="flex items-center gap-1 border-b border-border bg-muted/40 px-3 py-1.5 font-ui text-xs text-muted-foreground">{title}</div>
			{sortGroups(items).map((g) => <div key={g.key}>{renderSource(g, 0)}</div>)}
		</div>;
	};

	return <div className="flex flex-1 flex-col">
		{sortGroups(vaultRoot).map((g) => <div key={g.key}>{renderSource(g, 0)}</div>)}
		{vaultRoots.map((f) => renderFolder(f, 0))}
		{renderFlatGroup("Uploads", uploads, "source-group-uploads")}
		{renderFlatGroup("Chats", chats, "source-group-chats")}
		{sortGroups(orphans).map((g) => <div key={g.key}>{renderSource(g, 0)}</div>)}
		{/* Blank space below the tree clears row highlighting (chain-navigation). */}
		<div data-testid="chain-tree-blank" className="min-h-16 flex-1" />
	</div>;
}
