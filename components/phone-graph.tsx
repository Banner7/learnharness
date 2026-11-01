"use client";

/**
 * The phone graph (owner-approved 2026-11-01): the vault library's notes
 * browsed below 1100px, where the desktop canvas never loads. The list has
 * two tabs — Notes (title, folder, link/idea counts) and Topics (birth-session
 * clusters). Tapping a note opens a local radial graph drawn client-side in
 * plain SVG: the note at the center, its ideas on an inner ring, its wikilink
 * neighbors on an outer ring. Pan and pinch-zoom ride pointer events on the
 * SVG (no package); the app's global `touch-action: manipulation` already
 * stops double-tap zoom, and this SVG declares `touch-none` so pinch zooms
 * the graph, not the page.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, FileTextIcon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { tap } from "@/lib/haptics";
import { TopBar } from "@/components/top-bar";
import { GraphIdeaCard } from "@/components/graph-idea-card";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { Cluster, GraphNode, GraphNote, GraphSnapshot } from "@/src/core";

/** Radial layout radii and node sizes, in world units. Labels sit BELOW the
 *  shapes and the rings are tight enough that a 390 px phone fits them at
 *  ~0.95 scale, so 13 px labels stay readable (review 2026-11-01: at the
 *  first radii the fit scaled to 0.64 and labels rendered ~6 px). */
const INNER_RADIUS = 78;
const OUTER_RADIUS = 140;
const CENTER_SIDE = 34;
const IDEA_RADIUS = 7;
const NOTE_SIDE = 24;
/** Half the widest label, so edge labels are inside the fitted view. */
const LABEL_HALF_WIDTH = 50;
const LABEL_SIZE = 13;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

/** Truncate a label to n glyphs with an ellipsis (SVG has no CSS ellipsis). */
function truncate(label: string, n: number): string {
	return label.length > n ? `${label.slice(0, n - 1)}…` : label;
}

export function PhoneGraph() {
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [query, setQuery] = useState("");
	const [tab, setTab] = useState<"notes" | "topics">("notes");
	const [trail, setTrail] = useState<string[]>([]);
	const [idea, setIdea] = useState<GraphNode | null>(null);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

	const readState = useCallback(() => {
		fetch("/api/graph")
			.then((res) => res.json() as Promise<GraphSnapshot>)
			.then(setSnapshot)
			.catch(() => {});
	}, []);
	useEffect(() => {
		readState();
	}, [readState]);
	// Vault scans and extractions change notes, links and idea counts; the
	// snapshot refetches when sources change, on reconnect, and after any
	// client-side graph mutation elsewhere in the app.
	useServerEvent("sources-changed", readState);
	useServerResync(readState);
	useEffect(() => {
		window.addEventListener("lh:graph-revision", readState);
		return () => window.removeEventListener("lh:graph-revision", readState);
	}, [readState]);

	const notes = useMemo(() => snapshot?.notes ?? [], [snapshot]);
	const noteById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
	const nodeById = useMemo(() => new Map((snapshot?.nodes ?? []).map((n) => [n.id, n])), [snapshot]);

	// Ideas per source id: propositions whose provenance names that source.
	const noteIdeas = useMemo(() => {
		const map = new Map<string, GraphNode[]>();
		for (const p of snapshot?.propositions ?? []) {
			for (const sid of snapshot?.nodeSessions?.[p.id] ?? []) {
				let list = map.get(sid);
				if (!list) {
					list = [];
					map.set(sid, list);
				}
				list.push(p);
			}
		}
		return map;
	}, [snapshot]);

	// Idea id → the note title it was born from (first source that is a note).
	const ideaNoteTitles = useMemo(() => {
		const map = new Map<string, string>();
		for (const p of snapshot?.propositions ?? []) {
			for (const sid of snapshot?.nodeSessions?.[p.id] ?? []) {
				const n = noteById.get(sid);
				if (n) {
					map.set(p.id, n.title);
					break;
				}
			}
		}
		return map;
	}, [snapshot, noteById]);

	// Distinct linked-note ids per note (in + out).
	const linkedIds = useMemo(() => {
		const map = new Map<string, Set<string>>();
		const add = (a: string, b: string) => {
			let set = map.get(a);
			if (!set) {
				set = new Set();
				map.set(a, set);
			}
			set.add(b);
		};
		for (const link of snapshot?.noteLinks ?? []) {
			add(link.from, link.to);
			add(link.to, link.from);
		}
		return map;
	}, [snapshot]);

	const currentNoteId = trail[trail.length - 1] ?? null;
	const currentNote = currentNoteId !== null ? noteById.get(currentNoteId) ?? null : null;

	const q = query.trim().toLowerCase();
	const noteRows = notes.filter((n) => !q || n.title.toLowerCase().includes(q));
	const ideaRows = q !== "" ? (snapshot?.propositions ?? []).filter((p) => p.name.toLowerCase().includes(q)) : [];
	const clusters = snapshot?.clusters ?? [];

	return (
		<>
			{currentNoteId !== null && currentNote !== null ? (
				<LocalGraph
					note={currentNote}
					ideas={noteIdeas.get(currentNote.id) ?? []}
					linkedNotes={[...(linkedIds.get(currentNote.id) ?? [])].map((id) => noteById.get(id)).filter((n): n is GraphNote => n !== undefined)}
					nodeById={nodeById}
					onBack={() => setTrail((prev) => prev.slice(0, -1))}
					onRecenter={(id) => setTrail((prev) => [...prev, id])}
					onIdea={setIdea}
				/>
			) : (
				<div className="flex h-dvh flex-col bg-background text-foreground">
					<TopBar>
						<h1 className="font-title text-lg">Graph</h1>
					</TopBar>
					<div className="flex min-h-0 flex-1 flex-col">
						<div className="px-3 pb-2">
							<div className="relative">
								<SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
								<input
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									placeholder="Search notes and ideas"
									aria-label="Search notes and ideas"
									spellCheck={false}
									className="h-11 w-full rounded-lg border border-border bg-background pl-9 pr-3 font-ui text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
								/>
							</div>
						</div>
						<div className="px-3 pb-2">
							<div className="flex rounded-md bg-muted p-1" role="tablist" aria-label="Graph view">
								{(["notes", "topics"] as const).map((t) => (
									<button
										key={t}
										type="button"
										role="tab"
										aria-selected={tab === t}
										onClick={() => setTab(t)}
										className={cn(
											"min-h-11 flex-1 rounded-md text-sm font-medium",
											tab === t ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground",
										)}
									>
										{t === "notes" ? "Notes" : "Topics"}
									</button>
								))}
							</div>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
							{!snapshot ? (
								<p role="status" className="p-4 text-sm text-muted-foreground">Loading graph…</p>
							) : tab === "notes" ? (
								<NotesList
									notes={noteRows}
									ideaRows={ideaRows}
									linkedIds={linkedIds}
									noteIdeas={noteIdeas}
									ideaNoteTitles={ideaNoteTitles}
									empty={notes.length === 0}
									onNote={(id) => {
										tap();
										setTrail([id]);
									}}
									onIdea={(node) => {
										tap();
										setIdea(node);
									}}
								/>
							) : (
								<TopicsList
									clusters={clusters}
									query={q}
									nodeById={nodeById}
									expanded={expanded}
									onToggle={(id) => setExpanded((prev) => {
										const next = new Set(prev);
										if (next.has(id)) next.delete(id);
										else next.add(id);
										return next;
									})}
									onIdea={(node) => {
										tap();
										setIdea(node);
									}}
								/>
							)}
						</div>
					</div>
				</div>
			)}
			{idea && (
				<IdeaSheet
					idea={idea}
					snapshot={snapshot}
					onClose={() => setIdea(null)}
				/>
			)}
		</>
	);
}

function NotesList({
	notes,
	ideaRows,
	linkedIds,
	noteIdeas,
	ideaNoteTitles,
	empty,
	onNote,
	onIdea,
}: {
	notes: GraphSnapshot["notes"];
	ideaRows: GraphNode[];
	linkedIds: Map<string, Set<string>>;
	noteIdeas: Map<string, GraphNode[]>;
	ideaNoteTitles: Map<string, string>;
	empty: boolean;
	onNote: (id: string) => void;
	onIdea: (node: GraphNode) => void;
}) {
	if (empty) {
		return <p className="py-8 text-center text-sm text-muted-foreground">No vault notes yet</p>;
	}
	if (notes.length === 0 && ideaRows.length === 0) {
		return <p className="py-8 text-center text-sm text-muted-foreground">No matches</p>;
	}
	return (
		<ul className="flex flex-col">
			{notes.map((note) => {
				const links = linkedIds.get(note.id)?.size ?? 0;
				const ideas = noteIdeas.get(note.id)?.length ?? note.ideaCount;
				return (
					<li key={note.id} className="border-b border-border last:border-b-0">
						<button
							type="button"
							onClick={() => onNote(note.id)}
							className="flex min-h-11 w-full flex-col items-start justify-center gap-0.5 py-2 text-left"
						>
							<span className="text-sm font-medium text-foreground">{note.title}</span>
							{note.folder !== "" && <span className="text-xs text-muted-foreground">{note.folder}</span>}
							<span className="text-xs text-muted-foreground">{links} {links === 1 ? "link" : "links"} · {ideas} {ideas === 1 ? "idea" : "ideas"}</span>
						</button>
					</li>
				);
			})}
			{ideaRows.map((p) => (
				<li key={p.id} className="border-b border-border last:border-b-0">
					<button
						type="button"
						onClick={() => onIdea(p)}
						className="flex min-h-11 w-full items-center gap-2 py-2 text-left"
					>
						<FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-sm text-foreground">{p.name}</span>
							<span className="block truncate text-xs text-muted-foreground">{ideaNoteTitles.get(p.id) ?? "idea"}</span>
						</span>
						<ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
					</button>
				</li>
			))}
		</ul>
	);
}

function TopicsList({
	clusters,
	query,
	nodeById,
	expanded,
	onToggle,
	onIdea,
}: {
	clusters: Cluster[];
	query: string;
	nodeById: Map<string, GraphNode>;
	expanded: ReadonlySet<string>;
	onToggle: (id: string) => void;
	onIdea: (node: GraphNode) => void;
}) {
	const visible = clusters.filter((c) => {
		if (query === "") return true;
		const label = c.label ?? "";
		return label.toLowerCase().includes(query);
	});
	if (visible.length === 0) {
		return <p className="py-8 text-center text-sm text-muted-foreground">No topics yet</p>;
	}
	return (
		<ul className="flex flex-col">
			{visible.map((cluster) => {
				const ideas = cluster.members.map((id) => nodeById.get(id)).filter((n): n is GraphNode => n !== undefined);
				const open = expanded.has(cluster.id);
				return (
					<li key={cluster.id} className="border-b border-border last:border-b-0">
						<button
							type="button"
							onClick={() => onToggle(cluster.id)}
							aria-expanded={open}
							className="flex min-h-11 w-full items-center gap-2 py-2 text-left"
						>
							{open ? <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />}
							<span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{cluster.label ?? "Unlabeled"}</span>
							<span className="shrink-0 text-xs text-muted-foreground">{ideas.length} {ideas.length === 1 ? "idea" : "ideas"}</span>
						</button>
						{open && (
							<ul className="mb-2 flex flex-col border-l border-border pl-4">
								{ideas.map((node) => (
									<li key={node.id}>
										<button
											type="button"
											onClick={() => onIdea(node)}
											className="flex min-h-11 w-full items-start gap-2 py-2 text-left"
										>
											<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{node.name}</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</li>
				);
			})}
		</ul>
	);
}

function IdeaSheet({
	idea,
	snapshot,
	onClose,
}: {
	idea: GraphNode;
	snapshot: GraphSnapshot | null;
	onClose: () => void;
}) {
	return (
		<div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Idea">
			<div className="absolute inset-0 bg-black/40" onClick={onClose} />
			<div className="absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-border bg-card px-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-3">
				<div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0 flex-1">
						<GraphIdeaCard
							node={idea}
							sourceIds={snapshot?.nodeSessions?.[idea.id] ?? []}
							sessions={snapshot?.sessions ?? {}}
							fileSources={snapshot?.fileSources ?? {}}
						/>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<XIcon className="size-4" />
					</button>
				</div>
			</div>
		</div>
	);
}

function LocalGraph({
	note,
	ideas,
	linkedNotes,
	nodeById,
	onBack,
	onRecenter,
	onIdea,
}: {
	note: GraphNote;
	ideas: GraphNode[];
	linkedNotes: GraphNote[];
	nodeById: Map<string, GraphNode>;
	onBack: () => void;
	onRecenter: (id: string) => void;
	onIdea: (node: GraphNode) => void;
}) {
	const svgRef = useRef<SVGSVGElement | null>(null);
	const groupRef = useRef<SVGGElement | null>(null);
	const viewRef = useRef({ x: 0, y: 0, k: 1 });
	const movedRef = useRef(false);
	const tapTargetRef = useRef<Element | null>(null);
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const drag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
	const pinch = useRef<{ startDist: number; startK: number; cx: number; cy: number; origX: number; origY: number } | null>(null);

	const apply = useCallback(() => {
		const g = groupRef.current;
		if (g) g.setAttribute("transform", `translate(${viewRef.current.x} ${viewRef.current.y}) scale(${viewRef.current.k})`);
	}, []);

	// Fit the graph on mount and whenever the centered note changes.
	useLayoutEffect(() => {
		const svg = svgRef.current;
		if (!svg) return;
		const { clientWidth: w, clientHeight: h } = svg;
		const radius = OUTER_RADIUS + LABEL_HALF_WIDTH;
		const k = Math.max(MIN_SCALE, Math.min((w / 2 - 16) / radius, (h / 2 - 16) / radius, 1));
		viewRef.current = { x: w / 2, y: h / 2, k };
		apply();
	}, [note.id, apply]);

	const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
		tapTargetRef.current = event.target as Element;
		event.currentTarget.setPointerCapture(event.pointerId);
		pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pointers.current.size === 1) {
			movedRef.current = false;
			drag.current = { startX: event.clientX, startY: event.clientY, origX: viewRef.current.x, origY: viewRef.current.y };
		} else if (pointers.current.size === 2) {
			movedRef.current = true;
			const pts = [...pointers.current.values()];
			const a = pts[0];
			const b = pts[1];
			if (a === undefined || b === undefined) return;
			pinch.current = {
				startDist: Math.hypot(a.x - b.x, a.y - b.y),
				startK: viewRef.current.k,
				cx: (a.x + b.x) / 2,
				cy: (a.y + b.y) / 2,
				origX: viewRef.current.x,
				origY: viewRef.current.y,
			};
			drag.current = null;
		}
	};

	const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
		if (!pointers.current.has(event.pointerId)) return;
		pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pointers.current.size === 1 && drag.current) {
			const dx = event.clientX - drag.current.startX;
			const dy = event.clientY - drag.current.startY;
			if (Math.hypot(dx, dy) > 6) movedRef.current = true;
			if (movedRef.current) {
				viewRef.current.x = drag.current.origX + dx;
				viewRef.current.y = drag.current.origY + dy;
				apply();
			}
		} else if (pointers.current.size === 2 && pinch.current) {
			const pts = [...pointers.current.values()];
			const a = pts[0];
			const b = pts[1];
			if (a === undefined || b === undefined) return;
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			if (dist > 0 && pinch.current.startDist > 0) {
				const newK = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinch.current.startK * (dist / pinch.current.startDist)));
				// Zoom about the pinch centroid: keep the world point under it fixed.
				const worldX = (pinch.current.cx - pinch.current.origX) / pinch.current.startK;
				const worldY = (pinch.current.cy - pinch.current.origY) / pinch.current.startK;
				viewRef.current.k = newK;
				viewRef.current.x = pinch.current.cx - worldX * newK;
				viewRef.current.y = pinch.current.cy - worldY * newK;
				apply();
			}
		}
	};

	const finishPointer = (event: React.PointerEvent<SVGSVGElement>) => {
		const wasSingleTap = pointers.current.size === 1 && drag.current !== null && !movedRef.current;
		pointers.current.delete(event.pointerId);
		if (pointers.current.size === 0) {
			drag.current = null;
			pinch.current = null;
		} else if (pointers.current.size === 1) {
			// Pinch ended: resume single-finger panning from the remaining pointer.
			const p = [...pointers.current.values()][0];
			if (p !== undefined) {
				drag.current = { startX: p.x, startY: p.y, origX: viewRef.current.x, origY: viewRef.current.y };
				movedRef.current = true;
			}
		}
		if (wasSingleTap && tapTargetRef.current) {
			const el = tapTargetRef.current.closest("[data-note-id],[data-idea-id]");
			if (el) {
				const noteId = el.getAttribute("data-note-id");
				const ideaId = el.getAttribute("data-idea-id");
				if (noteId !== null) onRecenter(noteId);
				else if (ideaId !== null) {
					const node = nodeById.get(ideaId);
					if (node) onIdea(node);
				}
			}
		}
		tapTargetRef.current = null;
	};

	// Ring geometry: ideas evenly on the inner ring, links on the outer.
	const ideaPositions = ideas.map((node, i) => {
		const angle = -Math.PI / 2 + (i * 2 * Math.PI) / ideas.length;
		return { node, x: Math.cos(angle) * INNER_RADIUS, y: Math.sin(angle) * INNER_RADIUS };
	});
	const linkPositions = linkedNotes.map((n, i) => {
		const angle = -Math.PI / 2 + (i * 2 * Math.PI) / linkedNotes.length;
		return { note: n, x: Math.cos(angle) * OUTER_RADIUS, y: Math.sin(angle) * OUTER_RADIUS };
	});

	const noIdeas = ideas.length === 0;
	const noLinks = linkedNotes.length === 0;

	return (
		<div className="flex h-dvh flex-col bg-background text-foreground">
			<header className="flex h-[calc(3.5rem+env(safe-area-inset-top))] select-none items-center gap-1 border-b border-border px-2 pt-[env(safe-area-inset-top)]">
				<button
					type="button"
					onClick={() => {
						tap();
						onBack();
					}}
					aria-label="Back"
					className="flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground hover:bg-accent"
				>
					<ArrowLeftIcon className="size-5" />
				</button>
				<h1 className="min-w-0 flex-1 truncate font-title text-base text-foreground">{note.title}</h1>
			</header>
			<div className="relative min-h-0 flex-1">
				<svg
					ref={svgRef}
					className="h-full w-full touch-none"
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={finishPointer}
					onPointerCancel={finishPointer}
				>
					<g ref={groupRef}>
						{/* Links: dashed lines to the center (outer ring → center). */}
						{linkPositions.map(({ note: linked, x, y }) => (
							<line key={`link-${linked.id}`} x1={0} y1={0} x2={x} y2={y} stroke="var(--border)" strokeDasharray="4 4" strokeWidth={1.5} />
						))}
						{/* Ideas: solid lines to the center (inner ring → center). */}
						{ideaPositions.map(({ node, x, y }) => (
							<line key={`idea-link-${node.id}`} x1={0} y1={0} x2={x} y2={y} stroke="var(--muted-foreground)" strokeWidth={1.5} />
						))}
						{/* Inner ring: ideas. */}
						{ideaPositions.map(({ node, x, y }) => (
							<g key={`idea-${node.id}`} data-idea-id={node.id}>
								<circle cx={x} cy={y} r={28} fill="transparent" />
								<circle cx={x} cy={y} r={IDEA_RADIUS} fill="var(--muted-foreground)" />
								<text x={x} y={y + IDEA_RADIUS + 15} textAnchor="middle" className="font-ui" fontSize={LABEL_SIZE} fill="var(--muted-foreground)">
									{truncate(node.name, 14)}
								</text>
							</g>
						))}
						{/* Outer ring: linked notes. */}
						{linkPositions.map(({ note: linked, x, y }) => (
							<g key={`note-${linked.id}`} data-note-id={linked.id}>
								<rect x={x - 50} y={y - 24} width={100} height={60} fill="transparent" />
								<rect
									x={x - NOTE_SIDE / 2}
									y={y - NOTE_SIDE / 2}
									width={NOTE_SIDE}
									height={NOTE_SIDE}
									rx={10}
									fill="none"
									stroke="var(--muted-foreground)"
									strokeWidth={1.5}
								/>
								<text x={x} y={y + NOTE_SIDE / 2 + 16} textAnchor="middle" className="font-ui" fontSize={LABEL_SIZE} fill="var(--foreground)">
									{truncate(linked.title, 14)}
								</text>
							</g>
						))}
						{/* Center: this note. */}
						<rect x={-CENTER_SIDE / 2} y={-CENTER_SIDE / 2} width={CENTER_SIDE} height={CENTER_SIDE} rx={12} fill="var(--primary)" />
						<text x={0} y={CENTER_SIDE / 2 + 18} textAnchor="middle" className="font-ui" fontSize={LABEL_SIZE + 1} fontWeight={600} fill="var(--foreground)">
							{truncate(note.title, 18)}
						</text>
						{noIdeas && (
							<text x={0} y={CENTER_SIDE / 2 + 36} textAnchor="middle" className="font-ui" fontSize={12} fill="var(--muted-foreground)">
								Not synced yet
							</text>
						)}
						{noLinks && !noIdeas && (
							<text x={0} y={CENTER_SIDE / 2 + 36} textAnchor="middle" className="font-ui" fontSize={12} fill="var(--muted-foreground)">
								No links
							</text>
						)}
					</g>
				</svg>
			</div>
			<div className="border-t border-border px-4 py-2 font-ui text-xs text-muted-foreground">
				<span>◆ this note · ◇ linked note · ● idea · ┄ wikilink</span>
			</div>
		</div>
	);
}
