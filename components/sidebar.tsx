"use client";

import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { usePathname, useRouter } from "@/web/navigation";
import { MenuShell } from "@/components/menu-shell";
import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import type { ChatDeleteMode } from "@/src/core";
import { DumbbellIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { ActivitySection } from "@/components/activity-dock";
import { CoverageMenuBlock } from "@/components/extraction-coverage";
import { LhMark } from "@/components/lh-mark";
import { BrailleSpinner } from "@/components/braille-spinner";
import { SettingsDialogProvider, useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { Hint } from "@/components/ui/hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fuzzyScore } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { ChatListItem } from "@/src/core";
import { useSwipeReveal } from "@/components/use-swipe-reveal";

/** Navigation always uses a dismissible drawer, regardless of window width. */



const SidebarContext = createContext<{
	open: boolean;
	toggle: () => void;
	close: () => void;
}>({
	open: false,
	toggle: () => {},
	close: () => {},
});

function useSidebar() {
	return useContext(SidebarContext);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
	const [open, setOpen] = useState(false);
	const pathname = usePathname();
	const close = useCallback(() => setOpen(false), []);
	useEffect(() => {
		setOpen(false);
	}, [pathname]);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	const toggle = useCallback(() => setOpen((value) => !value), []);

	return (
		<SidebarContext.Provider value={{ open, toggle, close }}>
			<div className={cn("flex h-dvh", mounted && "[&_.sidebar-motion]:transition-[width,margin,opacity]")}>{children}</div>
		</SidebarContext.Provider>
	);
}

/** Drawer toggle keeps its layout slot mounted through open/close so
 * the header does not jump while the drawer animates. */
export function SidebarToggle() {
	const { open, toggle } = useSidebar();
	return (
		<span
			className={cn(
				"sidebar-motion relative flex h-11 shrink-0 overflow-hidden duration-200",
				open ? "w-0 -mr-3" : "w-11 mr-0",
			)}
		>
			<Hint label="Open sidebar">
			<Button
				variant="ghost"
				size="icon"
				aria-label="Open sidebar"
				aria-hidden={open}
				tabIndex={open ? -1 : 0}
				onClick={toggle}
				className={cn("sidebar-motion size-11 duration-200", open ? "pointer-events-none opacity-0" : "opacity-100")}
			>
				{/* Owner, round 6: size-4, SAME as the close glyph — the toggle
				    must not grow when the sidebar is closed (it did: size-5 here).
				    The small look is the standard, both directions. */}
				<PanelLeftOpenIcon className="size-4" />
			</Button>
			</Hint>
		</span>
	);
}

/**
 * The row's status indicator (owner, minimal-color round): the braille
 * spinner, ONLY while a teach turn is in flight — monochrome motion, the
 * terminal's own glyph, existing exactly as long as the work does and
 * vanishing the moment it ends. Every other state renders NOTHING:
 * phases only advance (all sessions end in Teaching — phase-as-signal was
 * decoration, now retired app-wide), and question-pending is the dominant
 * RESTING state of real sessions — a resting state has no scan value, so
 * the meta line's "Waiting for input" text carries it. Idle is the
 * absence of a signal, by design.
 */
function SessionStatus({ busy }: { busy: boolean }) {
	if (!busy) return null;
	return <BrailleSpinner />;
}

/** Compact "how long ago": "just now", "5m ago", "3h ago", "2d ago",
 *  then a plain date. How long a session has been WAITING matters more
 *  than an absolute timestamp. Beyond a week the date renders ISO
 *  (YYYY-MM-DD, zero-padded) — the international standard: unambiguous
 *  in any locale and it sorts (owner, typography round 5; the old
 *  M/D/YYYY was the US convention. A user-locale setting can come later
 *  — trivial, a format function swap). Pure — exported for tests. */
export function timeAgo(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}

/** The row's second line (redesign 2026-10-29): a state, when one exists,
 *  always shows — it is the useful fact. The date only shows where the list
 *  is not grouped by day (home); in the day-grouped sidebar it would repeat
 *  the group heading, so an idle row there is just its title. */
function sessionMeta(chat: ChatListItem, dated: boolean): string | null {
	const when = dated ? `, ${timeAgo(chat.updatedAt)}` : "";
	if (chat.compacting) return `Compacting context${when}`;
	if (chat.pendingQuestion) return `Waiting for input${when}`;
	if ((chat.kind ?? "teach") === "practice" && chat.pendingProblem) {
		return `Problem waiting${when}`;
	}
	if (chat.busy) return "Working…";
	return dated ? timeAgo(chat.updatedAt) : null;
}

/** A day-group heading in words: Today, Yesterday, else "October 10"
 *  (with the year once it is not this year). */
function dayHeading(date: Date, now: Date): string {
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (date.toDateString() === now.toDateString()) return "Today";
	if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
	return date.toLocaleDateString(undefined, {
		month: "long",
		day: "numeric",
		...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
	});
}

/**
 * One session row: the status spinner (only while working), then title +
 * state-aware meta, with a touch/pen reveal action behind the row.
 * Exported for render tests.
 */
export function SessionRow({
	chat,
	active,
	onOpen,
	onContextMenu,
	swipeOpen = false,
	onSwipeOpenChange,
	onSwipeDelete,
	dated = true,
}: {
	chat: ChatListItem;
	active: boolean;
	onOpen: () => void;
	/** Right-click or touch/pen long-press opens the same context menu. */
	onContextMenu?: (anchor: HTMLButtonElement) => void;
	swipeOpen?: boolean;
	onSwipeOpenChange?: (open: boolean) => void;
	onSwipeDelete?: () => void;
	/** False inside a day-grouped list: the heading already says when. */
	dated?: boolean;
}) {
	const meta = sessionMeta(chat, dated);
	const swipe = useSwipeReveal(swipeOpen, (next) => onSwipeOpenChange?.(next));
	const hold = useRef<{ pointerId: number; x: number; y: number; timer: number; opened: boolean } | null>(null);
	const suppressHoldClick = useRef(false);
	const suppressionTimer = useRef<number | undefined>(undefined);
	const touchContextUntil = useRef(0);
	useEffect(() => () => {
		if (hold.current) clearTimeout(hold.current.timer);
		clearTimeout(suppressionTimer.current);
	}, []);
	const cancelHold = () => {
		if (hold.current) clearTimeout(hold.current.timer);
		hold.current = null;
	};
	const onRowPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
		if (!onContextMenu || !event.isPrimary || (event.pointerType !== "touch" && event.pointerType !== "pen")) return;
		cancelHold();
		clearTimeout(suppressionTimer.current);
		suppressHoldClick.current = false;
		touchContextUntil.current = Date.now() + 1200;
		const anchor = event.currentTarget;
		const pending = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			timer: 0,
			opened: false,
		};
		pending.timer = window.setTimeout(() => {
			if (hold.current !== pending) return;
			pending.opened = true;
			suppressHoldClick.current = true;
			onContextMenu?.(anchor);
			navigator.vibrate?.(10);
		}, 500);
		hold.current = pending;
	};
	const onRowPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const pending = hold.current;
		if (!pending || pending.pointerId !== event.pointerId) return;
		if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8 || swipe.dragging) {
			cancelHold();
		}
	};
	const onRowPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
		if (hold.current?.pointerId !== event.pointerId) return;
		const opened = hold.current.opened;
		cancelHold();
		if (opened) {
			// A long-press click may target the button or the wrapper after capture.
			// Discard the flag if the browser never synthesizes one.
			suppressionTimer.current = window.setTimeout(() => {
				suppressHoldClick.current = false;
			}, 700);
		}
	};
	const handleContentClick = (event: React.MouseEvent<HTMLElement>) => {
		if (suppressHoldClick.current && event.detail !== 0) {
			suppressHoldClick.current = false;
			event.preventDefault();
			return;
		}
		if (swipe.consumeSwipeClick(event)) return;
		if (swipeOpen) onSwipeOpenChange?.(false);
		else onOpen();
	};
	const handleContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
		if (!onContextMenu) return;
		event.preventDefault();
		// Android can emit a native contextmenu after our touch timer. It is
		// not another request to open (or re-anchor) the menu.
		const pointerType = "pointerType" in event.nativeEvent ? event.nativeEvent.pointerType : undefined;
		if (pointerType === "touch" || pointerType === "pen" || (pointerType !== "mouse" && Date.now() < touchContextUntil.current)) return;
		onContextMenu(event.currentTarget);
	};
	return (
		<div
			className={cn("relative overflow-hidden border-b border-border touch-pan-y", onSwipeDelete && swipe.offset !== 0 && "bg-destructive")}
			onPointerDown={swipe.onPointerDown}
			onPointerMove={(event) => {
				onRowPointerMove(event);
				swipe.onPointerMove(event);
			}}
			onPointerUp={(event) => {
				onRowPointerEnd(event);
				swipe.onPointerUp(event);
			}}
			onPointerCancel={(event) => {
				onRowPointerEnd(event);
				swipe.onPointerCancel(event);
			}}
			onClick={(event) => {
				// Pointer capture may deliver a touch-generated click to the wrapper
				// after the content button has narrowed or changed width.
				if (event.target === event.currentTarget) handleContentClick(event);
			}}
		>
			{onSwipeDelete && (
				<button
					type="button"
					data-testid="session-swipe-delete"
					aria-label={`Delete session ${chat.title}`}
					aria-hidden={!swipe.revealed}
					tabIndex={swipe.revealed ? 0 : -1}
					onClick={(event) => {
						if (!swipe.consumeSwipeClick(event)) onSwipeDelete();
					}}
					className={cn(
						"absolute inset-y-0 right-0 flex w-20 items-center justify-center text-xs text-primary-foreground",
						!swipe.revealed && "invisible",
					)}
				>
					Delete
				</button>
			)}
			<button
				type="button"
				onPointerDown={onRowPointerDown}
				onClick={handleContentClick}
				onContextMenu={handleContextMenu}
				data-testid="session-row"
				className={cn(
					"relative flex min-h-14 touch-pan-y select-none items-center gap-2 bg-background px-3 py-2 text-left [-webkit-touch-callout:none] hover:bg-muted",
					!swipe.dragging && "transition-[width,background-color] duration-200 motion-reduce:transition-none",
				)}
				style={{ width: `calc(100% - ${-swipe.offset}px)` }}
			>
				<SessionStatus busy={chat.busy || chat.compacting} />
				<span className="min-w-0 flex-1">
					{/* Redesign (2026-10-29): the title is the row; the meta line
					    renders only when it says something (see sessionMeta). The
					    current session is marked by color alone: no weight change
					    (owner, round 5), so a truncated title never reflows. */}
					<span className={cn("block truncate font-title text-base", active && "text-primary")}>{chat.title}</span>
					{meta && <span className="block font-ui text-xs text-muted-foreground tabular-nums">{meta}</span>}
				</span>
				{/* The dumbbell rides the FAR RIGHT (owner round 6, 2026-10-05) —
				    was left of the name; right-aligned keeps the titles flush with
				    the teaching rows and reads cleaner. */}
				{(chat.kind ?? "teach") === "practice" && (
					<DumbbellIcon className="size-3.5 shrink-0 text-muted-foreground/70" aria-label="Practice session" />
				)}
			</button>
		</div>
	);
}

/** The inline-rename row (wave 6): same geometry as SessionRow, but the
 *  title line becomes a text input — select-all on entry (the click means
 *  "replace", the header rename's rule), Enter/blur commits, Esc discards.
 *  The meta line stays so the row never changes height mid-edit. */
export function RenameRow({ chat, onCommit, onCancel, dated = true }: { chat: ChatListItem; onCommit: (next: string) => void; onCancel: () => void; dated?: boolean }) {
	const meta = sessionMeta(chat, dated);
	const [draft, setDraft] = useState(chat.title);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	return (
		<div
			data-testid="session-rename-row"
			className="relative flex min-h-14 w-full items-center border-b border-border px-3 py-2"
		>
			{/* NOTHING MOVES (owner, polish round): an idle row renders no
			    status spacer (SessionStatus is null when not busy), so the
			    title starts at the row's own px-3 — 12px in. The old rename
			    row always carried a 14px spacer + gap + the input's border
			    and padding, landing the text ~41px in (and the meta with
			    it). The input here is borderless and padding-free at the
			    exact title x; the underline is the only editing cue. */}
			<span className="flex min-w-0 w-full flex-col">
				<input
					ref={inputRef}
					value={draft}
					spellCheck={false}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => onCommit(draft)}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							e.stopPropagation(); // cancel only this rename
							onCancel();
						}
					}}
					aria-label="Rename session"
					data-testid="session-rename-input"
					className="lh-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-foreground outline-none"
				/>
				{meta && <span className="block truncate font-ui text-xs text-muted-foreground tabular-nums">{meta}</span>}
			</span>
		</div>
	);
}

/** Continue = sidebar rows (owner, 2026-10-27): one interaction surface
 * for session management, regardless of where the list is shown. */
export function SessionList({
	chats,
	activeId,
	onOpen,
	onRemoved,
	className,
	empty,
	grouped = false,
}: {
	chats: ChatListItem[];
	activeId: string | null;
	onOpen: (chat: ChatListItem) => void;
	onRemoved: (id: string) => void;
	className?: string;
	empty?: React.ReactNode;
	/** Day headings above the rows (the sidebar); home lists stay flat. */
	grouped?: boolean;
}) {
	const pathname = usePathname();
	const router = useRouter();
	const [swipedChatId, setSwipedChatId] = useState<string | null>(null);
	const [ctxChatId, setCtxChatId] = useState<string | null>(null);
	const ctxAnchorRef = useRef<HTMLElement | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ChatListItem | null>(null);
	const openDelete = (chat: ChatListItem) => {
		setDeleting(chat);
		setSwipedChatId(null);
	};
	const openContext = (anchor: HTMLButtonElement, chat: ChatListItem) => {
		ctxAnchorRef.current = anchor;
		setSwipedChatId(null);
		setCtxChatId(chat.id);
	};

	// Pointerdown outside the menu or its row dismisses it.
	useEffect(() => {
		if (ctxChatId === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (ctxAnchorRef.current?.contains(target)) return;
			setCtxChatId(null);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [ctxChatId]);

	// Inline rename shares the chat header's persistence and broadcasts
	// lh:chat-renamed so other mounted views update immediately.
	const commitRename = useCallback(async (id: string, next: string) => {
		setRenamingId(null);
		const t = next.trim();
		if (t === "") return;
		try {
			const res = await fetch(`/api/chats/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: t }),
			});
			if (!res.ok) throw new Error(`rename failed: ${res.status}`);
			window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id, title: t } }));
		} catch (err) {
			console.error("rename failed:", err); // keep the old title
		}
	}, []);

	// Patch the owning list immediately, return home when deleting the open
	// chat, and notify the home knowledge summary to refresh graph data.
	const onDeleted = (id: string, _mode: ChatDeleteMode, graphRevision: number) => {
		setDeleting(null);
		onRemoved(id);
		if (pathname === `/chat/${id}`) router.push("/");
		window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: graphRevision } }));
	};
	// Export: a direct attachment link can open outside the installed app
	// in a markdown viewer with no route back.
	// Share a file when possible; otherwise download a blob in-place.
	const exportMarkdown = async (chat: ChatListItem) => {
		try {
			const res = await fetch(`/api/chats/${chat.id}/markdown`, { credentials: "same-origin" });
			if (!res.ok) throw new Error(`export failed: ${res.status}`);
			const filename = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/i)?.[1] ?? `${chat.title}.md`;
			const blob = await res.blob();
			const file = new File([blob], filename, { type: "text/markdown" });
			if (navigator.canShare?.({ files: [file] })) {
				try {
					await navigator.share({ files: [file] });
					return;
				} catch (err) {
					if (err instanceof DOMException && err.name === "AbortError") return;
					// Share can lose transient activation during fetch on iOS;
					// use the in-page blob download for every other failure.
				}
			}
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch (err) {
			console.error("export failed:", err);
		}
	};
	const now = new Date();

	return (
		<>
			<div className={className} onScroll={() => setSwipedChatId(null)}>
				{chats.length === 0 ? empty : chats.map((c, index) => {
					const date = new Date(c.updatedAt);
					const day = date.toDateString();
					const previousDay = index > 0 ? new Date(chats[index - 1]!.updatedAt).toDateString() : null;
					return (
						<Fragment key={c.id}>
							{grouped && day !== previousDay && (
								<div className="px-3 pb-1 pt-4 font-ui text-xs text-muted-foreground">{dayHeading(date, now)}</div>
							)}
							{renamingId === c.id ? (
								<RenameRow
									chat={c}
									dated={!grouped}
									onCommit={(next) => void commitRename(c.id, next)}
									onCancel={() => setRenamingId(null)}
								/>
							) : (
								<SessionRow
									chat={c}
									dated={!grouped}
									active={activeId === c.id}
									swipeOpen={swipedChatId === c.id}
									onSwipeOpenChange={(next) => setSwipedChatId(next ? c.id : null)}
									onSwipeDelete={() => openDelete(c)}
									onOpen={() => {
										setSwipedChatId(null);
										onOpen(c);
									}}
									onContextMenu={(anchor) => openContext(anchor, c)}
								/>
							)}
						</Fragment>
					);
				})}
			</div>
			{ctxChatId !== null && (
				<MenuShell
					anchorRef={ctxAnchorRef}
					testid="session-context-menu"
					preferredSide="down"
					menuClass="flex w-52 flex-col gap-0.5 rounded-xl border border-border bg-popover p-2 text-sm shadow-lg"
				>
					{/* The two management actions first, then the extraction block
					    (owner refinement round, 2026-09-24): Rename/Delete stay at the
					    top, the coverage numbers + Extract affordance sit below the
					    hairline — the block is info + a stateful affordance, the
					    actions above it. Fetched on menu open (the block mounts WITH
					    the menu); 409 = benign. Renders nothing on a failed read. */}
					<button
						type="button"
						data-testid="ctx-rename"
						onClick={() => {
							setRenamingId(ctxChatId);
							setCtxChatId(null);
						}}
						className="flex min-h-11 items-center rounded-md px-2.5 text-left text-foreground hover:bg-muted"
					>
						Rename
					</button>
					{/* Export (owner, 2026-10-27): share or download without
					    navigating away from the standalone phone app. */}
					<button
						type="button"
						data-testid="ctx-export-md"
						onClick={() => {
							const target = chats.find((c) => c.id === ctxChatId);
							setCtxChatId(null);
							if (target) void exportMarkdown(target);
						}}
						className="flex min-h-11 items-center rounded-md px-2.5 text-left text-foreground hover:bg-muted"
					>
						Export as Markdown…
					</button>
					<button
						type="button"
						data-testid="ctx-delete"
						onClick={() => {
							const target = chats.find((c) => c.id === ctxChatId);
							if (target) openDelete(target);
							setCtxChatId(null);
						}}
						className="flex min-h-11 items-center rounded-md px-2.5 text-left text-destructive hover:bg-muted"
					>
						Delete…
					</button>
					<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
					<CoverageMenuBlock chatId={ctxChatId} />
				</MenuShell>
			)}
			<DeleteSessionDialog
				chat={deleting}
				onClose={() => setDeleting(null)}
				onDeleted={onDeleted}
			/>
		</>
	);
}

/** The three-way kind filter (practice sessions, owner 2026-10-04):
 *  Teaching / All / Practice — a client-side filter over the same
 *  snapshot, persisted in localStorage, defaulting to All. */
type SessionKindFilter = "teach" | "all" | "practice";
const KIND_FILTER_KEY = "lh:session-kind-filter";

function SessionsSidebar() {
	const { open, toggle, close } = useSidebar();
	const drawerRef = useRef<HTMLElement>(null);
	useEffect(() => {
		if (!open) return;
		const previous = document.activeElement as HTMLElement | null;
		drawerRef.current?.querySelector<HTMLButtonElement>('[aria-label="Close sidebar"]')?.focus();
		return () => {
			if (previous?.isConnected) previous.focus();
		};
	}, [open]);
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const [query, setQuery] = useState("");
	const [kindFilter, setKindFilter] = useState<SessionKindFilter>("all");
	useEffect(() => {
		const stored = window.localStorage.getItem(KIND_FILTER_KEY);
		if (stored === "teach" || stored === "all" || stored === "practice") setKindFilter(stored);
	}, []);
	const setFilter = useCallback((f: SessionKindFilter) => {
		setKindFilter(f);
		window.localStorage.setItem(KIND_FILTER_KEY, f);
	}, []);
	const pathname = usePathname();
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();

	/* New session (owner, 2026-09-13): NO POST — the button opens the
	   sessionless draft view; the session is created only when the first
	   message is sent (and that message becomes its title). Search: a
	   client-side filter over the poll snapshot — no server round trip. */
	const newSession = useCallback(() => {
		close();
		router.push("/chat/new");
	}, [close, router]);

	/* FUZZY (owner round 8, 2026-10-05): subsequence match ranked by
	 * fuzzyScore — prefix beats word-boundary beats scattered. Empty query
	 * keeps the natural list order (scores are all 0, sort is stable). */
	const shown = useMemo(() => {
		const q = query.trim();
		let list = chats;
		if (list && kindFilter !== "all") {
			list = list.filter((c) => (c.kind ?? "teach") === kindFilter);
		}
		if (!list) return list;
		if (!q) return list;
		return list
			.map((c) => ({ c, score: fuzzyScore(q, c.title) }))
			.filter((r): r is { c: (typeof list)[number]; score: number } => r.score !== null)
			.sort((a, b) => b.score - a.score)
			.map((r) => r.c);
	}, [chats, query, kindFilter]);

	const refreshInFlightRef = useRef(false);
	const refresh = useCallback(async () => {
		// In-flight coalesce (S6): event bursts may land several refresh
		// calls at once — one fetch serves them all; anything newer arrives
		// with the next event's fetch.
		if (refreshInFlightRef.current) return;
		refreshInFlightRef.current = true;
		try {
			const res = await fetch("/api/chats", { cache: "no-store" });
			const d = (await res.json()) as { chats: ChatListItem[] };
			setChats(d.chats);
		} catch {
			// a transient failure keeps the last snapshot
			setChats((prev) => prev ?? []);
		} finally {
			refreshInFlightRef.current = false;
		}
	}, []);

	/* Instant rename propagation (2026-09-17): the chat header's rename
	   commits dispatch lh:chat-renamed; patch the snapshot in place instead
	   of waiting for the 2.5s poll. */
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, title } : c)) : prev));
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, []);

	/* INSTANT TURN-STATE (owner, sidebar round 2026-10-02): the open
	   session broadcasts lh:turn-state the instant its turn starts
	   (submitted — the optimistic machine's own flip) and at settle —
	   busy mirrors the server's own definition (isTurnRunning), so the
	   patch is exact: spinner up the moment the action happens, cleared
	   and refetched once at settle (title/order move with turns). The
	   events channel is the backstop for everything only the server
	   knows: other windows, wake turns in unopened sessions. A start on
	   a chat not yet in the snapshot (a brand-new session) = one
	   immediate refresh instead of a patch. */
	const chatsRef = useRef(chats);
	chatsRef.current = chats;
	useEffect(() => {
		const onTurnState = (e: Event) => {
			const { id, running } = (e as CustomEvent<{ id: string; running: boolean }>).detail;
			if (running) {
				if (chatsRef.current?.some((c) => c.id === id)) {
					setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: true } : c)) : prev));
				} else {
					void refresh(); // the brand-new session: it isn't in the snapshot yet
				}
				return;
			}
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: false } : c)) : prev));
			void refresh(); // settle: the server snapshot is now truthful — land it now
		};
		window.addEventListener("lh:turn-state", onTurnState);
		return () => window.removeEventListener("lh:turn-state", onTurnState);
	}, [refresh]);

	/* PUSH (architecture S6, 2026-10-02): the 2.5s poll is RETIRED — the
	   last standing network poll in the app. List truth arrives as
	   events: chats-changed (create/rename/delete — the list-SHAPE
	   writes), and turn-started/turn-settled for EVERY chat (unfiltered:
	   any chat's turn flips busy/order/phase in this list). Announced
	   fetches ride the 250ms trailing debounce (the S4/S5 law); resync
	   (reconnect / dev-restart) is immediate. lh:turn-state +
	   lh:chat-renamed stay for same-tab INSTANTS — local beats any
	   round-trip. */
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	const eventDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const scheduleEventRefresh = () => {
		if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		eventDebounceRef.current = setTimeout(() => {
			eventDebounceRef.current = undefined;
			void refreshRef.current();
		}, 250);
	};
	useServerEvent("chats-changed", scheduleEventRefresh);
	useServerEvent("turn-started", scheduleEventRefresh);
	useServerEvent("turn-settled", scheduleEventRefresh);
	useServerEvent("compaction-changed", scheduleEventRefresh);
	useServerResync(() => void refreshRef.current());
	useEffect(
		() => () => {
			if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		},
		[],
	);



	useEffect(() => {
		if (!open) return;
		void refresh();
		// Opening + navigation refetch; while open, the events channel owns
		// freshness (S6) — no interval, nothing standing.
	}, [open, pathname, refresh]);

	return (
		<>
		{open && (
			<button
				type="button"
				aria-label="Close sidebar backdrop"
				tabIndex={-1}
				onClick={close}
				className="fixed inset-0 z-40 bg-background/70"
			/>
		)}
		<aside
			ref={drawerRef}
			className={cn(
				"sidebar-motion fixed inset-y-0 left-0 z-50 shrink-0 overflow-hidden duration-200",
				open ? "w-72 max-w-[calc(100vw-2rem)]" : "w-0",
			)}
			role="dialog"
			aria-modal={open ? true : undefined}
			aria-label="Navigation"
			aria-hidden={!open}
			inert={!open}
		>
			<div className="flex h-full w-72 max-w-full flex-col border-r bg-background">
				{/* Wordmark and drawer close toggle. */}
				<div
					className="flex items-center justify-between px-4 py-3"
					style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top))" }}
				>
					{/* The wordmark remains the home link. */}
					{/* Hover mirrors the ghost toggle buttons (owner ask, 2026-09-17):
					    same size-9 chip geometry, same hover:bg-accent treatment. */}
					<Hint label="Home" side="right">
						<Link
							href="/"
							onClick={close}
							aria-label="Home"
							className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted"
						>
							<LhMark className="size-6" />
						</Link>
					</Hint>
					<Hint label="Close sidebar">
						<Button
							variant="ghost"
							size="icon"
							aria-label="Close sidebar"
							onClick={toggle}
						>
							<PanelLeftCloseIcon className="size-4" />
						</Button>
					</Hint>
				</div>

				{/* Two doors, STACKED (owner round 8, 2026-10-05 — was a
				    half/half row): full-width rows read cleaner and give the
				    labels room; teaching keeps the original draft route,
				    practice carries its mode. */}
				<div className="mx-3 mb-2 flex flex-col gap-1.5">
					<button
						type="button"
						data-testid="new-session"
						onClick={() => void newSession()}
						className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<PlusIcon className="size-3" />
						Teaching
						<span className="sr-only">create a new teaching session</span>
					</button>
					<button
						type="button"
						data-testid="new-session-practice"
						onClick={() => {
							close();
							router.push("/chat/new?mode=practice");
						}}
						className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DumbbellIcon className="size-3" />
						Practice
						<span className="sr-only">create a new practice session</span>
					</button>
				</div>

				<div className="mx-3 mb-2 flex items-center gap-2">
					<span className="text-sm text-muted-foreground">Sessions</span>
					<Hint label="Search sessions" side="bottom">
					<span className="relative flex-1">
						<Input
							data-testid="session-search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search…"
							aria-label="Search sessions"
							className="h-11 rounded-md border-border bg-background pl-8 text-sm placeholder:text-muted-foreground/60"
						/>
						<SearchIcon className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/70" />
					</span>
					</Hint>
				</div>

				{/* The three-way filter, HEADING THE LIST (owner round 8b,
				    2026-10-05 — moved below the search): it scopes what the
				    list shows, so it sits directly above it as a caption row;
				    search stays the top muscle-memory target. Order: Teaching /
				    Practice / All — the real modes first, "All" as the escape
				    hatch on the right, mirroring the create-buttons above.
				    Persisted client-side. */}
				<div className="mx-3 flex items-center gap-0.5 rounded-md bg-muted p-0.5" data-testid="session-kind-filter">
					{(["teach", "practice", "all"] as const).map((f) => (
						<button
							key={f}
							type="button"
							data-testid={`kind-filter-${f}`}
							onClick={() => setFilter(f)}
							className={cn(
								"min-h-11 flex-1 rounded-md px-2 text-xs",
								kindFilter === f
									? "bg-card font-medium text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{f === "teach" ? "Teaching" : f === "all" ? "All" : "Practice"}
						</button>
					))}
				</div>

				{shown === null ? (
					<div className="flex-1 overflow-y-auto p-2">
						<div className="px-2 py-4 text-xs text-muted-foreground">Loading…</div>
					</div>
				) : (
					<SessionList
						chats={shown}
						activeId={pathname.startsWith("/chat/") ? pathname.slice("/chat/".length) : null}
						className="flex-1 overflow-y-auto px-3 py-2"
						grouped
						empty={
							<div className="px-2 py-4 text-xs text-muted-foreground">
								{query.trim() ? "No sessions match." : "No sessions yet."}
							</div>
						}
						onOpen={(chat) => {
							close();
							router.push(`/chat/${chat.id}`);
						}}
						onRemoved={(id) => setChats((prev) => (prev ? prev.filter((c) => c.id !== id) : prev))}
					/>
				)}

				<div className="shrink-0" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
					{/* Background agents (owner, sidebar round): the section is
					    ALWAYS here — empty means empty (the header sits alone); it
					    populates and grows when processes run. The session list is
					    flex-1, so this pins to the bottom. Sidebar closed = the
					    learner opted out (no ambient signal, user decision). */}
					<ActivitySection />

					{/* Settings opens the phone section sheet. */}
					<div className="px-3 pt-1">
						<Hint label="Settings" side="right">
							<button
								type="button"
								onClick={() => {
									close();
									openSettings();
								}}
								data-testid="settings-entry"
								className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								<SettingsIcon className="size-3" />
								Settings
							</button>
						</Hint>
					</div>
				</div>
				</div>

			</aside>
		</>
	);
}

/** The app frame: overlay drawer and full-width content. */
export function AppShell({ children }: { children: React.ReactNode }) {
	const { open } = useSidebar();
	return (
		<SettingsDialogProvider>
			<SessionsSidebar />
			<main className="min-w-0 flex-1" inert={open}>{children}</main>
		</SettingsDialogProvider>
	);
}
