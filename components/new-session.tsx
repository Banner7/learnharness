"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@/web/navigation";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Composer } from "@/components/composer";
import { SidebarToggle } from "@/components/sidebar";
import { tap } from "@/lib/haptics";

import { StatsBar } from "@/components/stats-bar";
import { ChainTableOverlay } from "@/components/chain-table.tsx";
import { ComposerActions, NodePickerControl } from "@/components/composer-actions";
import { OPENING_PROMPT_FAILURE } from "@/components/opening-prompt";
import { SessionStarter } from "@/components/start-session";
import type { ChatSettings, GraphSnapshot } from "@/src/core";

/** The draft's pick set (owner round 10): the SAME shape the home pick
 *  bar lifts — resolved nodes as the learner SAW them at pick time. */
export type DraftPick = { id: string; name: string; statement: string };

/**
 * The sessionless draft view at /chat/new (owner, 2026-09-13): "+ New
 * session" opens THIS, never a created record — a session comes to exist
 * only when the learner sends the first message, and that message becomes
 * the session's title (the exact create-then-redirect contract the home
 * composer established). Visually identical to a fresh chat: same header
 * (title + probe chip), the same empty state, the same composer blob +
 * stats dock. The draft's model control binds the strong slot (the
 * new-session default); the created session is stamped from it
 * server-side (per-session models, owner 2026-09-28).
 */

const DOCK = "mx-auto w-full max-w-[720px] px-4";

/**
 * Create, safely hand over the full opening text, then return a short
 * /chat/<id> target. Storage/creation failures leave the caller's draft
 * intact. A per-composer starter reuses an already-created session on an
 * unchanged retry. The server stamps settings at birth; no settings PUT.
 */
export async function startDraftSession(
	text: string,
	fetchLike: typeof fetch,
	mode?: "practice",
	picks?: readonly DraftPick[],
	starter = new SessionStarter(),
	settingsIdentity?: string,
): Promise<string | null> {
	const t = text.trim();
	if (!t) return null;
	// THE PICKS RIDE THE CREATE (owner round 10): a practice draft seeded
	// from the pick bar creates its session WITH the graph context — the
	// same contract as the home screen's practice send (the marker with
	// [id] name: statement lines, target validation's truth set).
	return starter.start(
		mode === "practice"
			? { title: t, kind: "practice", ...(picks && picks.length > 0 ? { graphContext: { propositions: picks } } : {}) }
			: { title: t },
		fetchLike,
		settingsIdentity,
	);
}

/** The pure shell (no router) — the render-test seam: the draft view's
 *  visible surface, assembled from the same pieces a fresh chat shows. */
export function DraftShell({
	busy,
	text,
	onChange,
	onSend,
	startError = false,
	mode = "teach",
	picks = [],
	onOpenPicker,
	onClearPicks,
	overlay,
}: {
	busy: boolean;
	text: string;
	onChange: (v: string) => void;
	onSend: () => void;
	startError?: boolean;
	/** The practice draft (owner, 2026-10-04): ?mode=practice — the
	 *  created session carries kind:"practice" and the copy changes
	 *  (the practice agent opens; no probing). */
	mode?: "teach" | "practice";
	/** THE PICK BAR (owner round 10): the SAME pill the home screen
	 *  carries above its composer — dashed "Pick nodes" when empty,
	 *  count + Clear when picked. The draft screen has
	 *  no graph behind it, so the picker opens the standalone chain-table
	 *  overlay over fetched snapshot data (owned by NewSession). */
	picks?: DraftPick[];
	onOpenPicker?: () => void;
	onClearPicks?: () => void;
	/** The picker overlay lives inside the content column. */
	overlay?: ReactNode;
}) {
	const canSend = text.trim().length > 0;
	return (
		/* Draft sessions use the home composer language without a title bar. */
		<div className="relative flex h-dvh">
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="relative flex min-h-0 flex-1">
					{/* The pointer-events pattern (953b22b): the sticky wrapper is
					    pointer-events-none so nothing here blocks the empty-state
					    area; the blob and the stats row re-enable it themselves. */}
					<div className="pointer-events-none sticky bottom-0 mt-auto w-full">
						<Conversation className="h-full min-w-0 flex-1" initial="instant">
							<ConversationContent className="min-h-full gap-0 p-0">
								<ConversationEmptyState
									title={mode === "practice" ? "New practice session" : "New session"}
									description={
										mode === "practice"
											? "Pick nodes from your knowledge graph, describe what you want to practice, or bring your own problem."
											: "The teacher will open by probing what you already know."
									}
								/>
							</ConversationContent>
						</Conversation>
						<div className="h-6" />
						<div className="bg-background pb-[max(1rem,env(safe-area-inset-bottom))]">
							<div className={DOCK}>
								<ComposerActions
									picker={(picks.length > 0 || mode === "practice") && (
										<NodePickerControl count={picks.length} onOpen={onOpenPicker} onClear={onClearPicks} />
									)}
								/>
								{startError && <p role="alert" className="pointer-events-auto mb-2 text-sm text-destructive">{OPENING_PROMPT_FAILURE}</p>}
								<div className="pointer-events-auto overflow-hidden rounded-xl border border-border bg-card">
									<Composer
										busy={busy}
										value={text}
										onChange={onChange}
										onSend={onSend}
										onStop={() => {}}
										canSend={canSend}
										autoFocus
										// No lesson has started yet, so the opening prompt remains a question.
										placeholder={mode === "practice" ? "What do you want to practice?" : "A topic, a question, or paste notes"}
									/>
								</div>
								<StatsBar turns={[]} />
							</div>
						</div>
					</div>
					{overlay}
				</div>
			</div>
			{/* The floating reopen toggle — pointer-events-none except the
			    toggle itself (home's pattern), painted AFTER the overlay's
			    column so nothing of it blocks the canvas area. */}
			<header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
				<div className="pointer-events-auto">
					<SidebarToggle />
				</div>
			</header>
		</div>
	);
}

export function NewSession({ mode = "teach" }: { mode?: "teach" | "practice" }) {
	const router = useRouter();
	const [text, setText] = useState("");
	// The draft stays current at every write so the send reads the latest text.
	const textRef = useRef("");
	const applyText = (v: string) => {
		textRef.current = v;
		setText(v);
	};
	const [busy, setBusy] = useState(false);
	const startingRef = useRef(false);
	const starterRef = useRef(new SessionStarter());
	const [startError, setStartError] = useState(false);
	// THE PICK BAR (owner round 10): the draft's lifted pick set + the
	// snapshot the standalone chain-table picker reads. Lazy — the graph
	// is fetched on FIRST open only, then reused.
	const [picks, setPicks] = useState<DraftPick[]>([]);
	const picksRef = useRef<DraftPick[]>([]);
	const applyPicks = (next: DraftPick[]) => {
		picksRef.current = next;
		setPicks(next);
	};
	const [pickerOpen, setPickerOpen] = useState(false);
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const openPicker = () => {
		if (snapshot) {
			setPickerOpen(true);
			return;
		}
		void fetch("/api/graph")
			.then((r) => r.json() as Promise<GraphSnapshot>)
			.then((snap) => {
				setSnapshot(snap);
				setPickerOpen(true);
			})
			.catch(() => {
				/* an unreachable graph leaves the draft usable — pickless */
			});
	};

	const send = useCallback(() => {
		tap();
		const draft = textRef.current.trim();
		if (!draft || startingRef.current) return;
		startingRef.current = true;
		setBusy(true);
		setStartError(false);
		// No setup catalog in this fork: reuse keys on the body alone (0.3.9 port, 2026-10-28).
		void startDraftSession(draft, fetch, mode === "practice" ? "practice" : undefined, mode === "practice" ? picksRef.current : undefined,
			starterRef.current)
			.then((target) => {
				if (target) router.push(target);
				else { startingRef.current = false; setBusy(false); }
			})
			.catch(() => {
				startingRef.current = false;
				setBusy(false);
				setStartError(true);
			});
	}, [router, mode]);

	return (
		<>
			<DraftShell
				busy={busy}
				startError={startError}
				text={text}
				onChange={applyText}
				onSend={send}
				mode={mode}
				picks={picks}
				onOpenPicker={openPicker}
				onClearPicks={() => applyPicks([])}
				overlay={
					// Host the picker inside the centered content column so it
					// covers neither the sidebar drawer nor the top bar.
					<ChainTableOverlay
						open={pickerOpen}
						nodes={snapshot?.propositions ?? []}
						chains={snapshot?.chains ?? []}
						sessions={snapshot?.sessions ?? {}}
						fileSources={snapshot?.fileSources ?? {}}
						onClose={() => setPickerOpen(false)}
						selectMode
						controlledSelection={new Set(picks.map((p) => p.id))}
						onSelectionChange={(ids) => {
							const byId = new Map((snapshot?.propositions ?? []).map((n) => [n.id, n]));
							const next: DraftPick[] = [];
							for (const id of ids) {
								const n = byId.get(id);
								if (n) next.push({ id: n.id, name: n.name, statement: n.statement });
							}
							applyPicks(next);
						}}
					/>
				}
			/>

		</>
	);
}