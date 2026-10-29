"use client";

/** Home session list, map summary, import action, chain picker, and extraction costs. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@/web/navigation";
import { ChainTableOverlay } from "@/components/chain-table.tsx";
import { planCostLabel } from "@/components/usage-format";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { NotesImportErrors, useNotesImport } from "@/components/notes-import.tsx";
import { SessionList } from "@/components/sidebar";
import { Hint } from "@/components/ui/hint";
import type { ChatListItem, GraphCostSummary, GraphSnapshot } from "@/src/core";

/** Compact token display: 45231 → "45.2k"; absent → "—". */
function fmtTokens(n: number | undefined): string {
	if (n === undefined) return "—";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Relative time for run rows: "now", "12m", "3h", "2d". */
function timeAgo(startedAt: number): string {
	const mins = Math.round((Date.now() - startedAt) / 60_000);
	if (mins < 1) return "now";
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

/** Run/stage cost at 3 decimals (pipeline pennies are real money at this
 *  scale); headline totals use 2. Null (unpriced model) renders "—". */
function fmtRunCost(dollars: number | null): string {
	return planCostLabel(dollars, (value) => `$${value.toFixed(3)}`);
}
function graphUsageLabel(costs: Pick<GraphCostSummary, "stages">): string {
	const stages = [costs.stages.extraction, costs.stages.audit];
	const priced = stages.some((stage) => stage.runs - stage.unpricedRuns > 0);
	const dollars = displayCostTotals(costs).totalDollars;
	return planCostLabel(priced ? dollars : null, (value) => `$${value.toFixed(2)}`);
}

/**
 * The cost figures the UI DISPLAYS (owner refinement round, 2026-09-24):
 * extraction + audit only. Cluster naming is dead — labels are session
 * titles / file names — so the core's naming fold (and its historical
 * spend) is deliberately not shown anywhere: the pill and the panel must
 * agree, and both read THIS, never GraphCostSummary.totalDollars.
 * (The core fold's naming stage was then culled outright — 2026-09-24 —
 * so the recent-runs list carries extraction runs only.)
 */
export function displayCostTotals(costs: Pick<GraphCostSummary, "stages">): {
	totalDollars: number;
	unpricedRuns: number;
} {
	// The two live stages (the spine came and went on one day,
	// 2026-09-30 — digest-aware extraction replaced it).
	return {
		totalDollars: costs.stages.extraction.dollars + costs.stages.audit.dollars,
		unpricedRuns: costs.stages.extraction.unpricedRuns + costs.stages.audit.unpricedRuns,
	};
}

/** The graph-pipeline cost control: cumulative cost with an expandable breakdown. */
export function GraphCostControl({ costs }: { costs: GraphCostSummary }) {
	const [open, setOpen] = useState(false);
	// Tapping outside closes the panel; its trigger also toggles it.
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	return (
		<div ref={rootRef} className="relative">
			<Hint
				// Trimmed (owner, subtlety round 2026-09-25).
				label="Graph costs — click for details"
				side="bottom"
			>
				<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className={`min-h-11 rounded-md px-2 font-ui text-xs tabular-nums hover:bg-accent ${
					open ? "text-foreground" : "text-muted-foreground hover:text-foreground"
				}`}
			>
				{graphUsageLabel(costs)}
			</button>
			</Hint>
			{open && (
				<div className="absolute right-0 top-full mt-2 max-h-[60vh] overflow-y-auto">
					<GraphCostPanel costs={costs} />
				</div>
			)}
		</div>
	);
}

/**
 * The cost control's expanded panel: stage totals (extraction / audit —
 * dollars headline, tokens secondary) + the recent-runs list.
 * Presentational: the fold happens server-side (core/cost-summary.ts);
 * dollars are inferred read-time, never stored. Cluster naming is GONE
 * from the panel (owner refinement round, 2026-09-24): labels are session
 * titles / file names now, the namer is dead, and its historical spend is
 * not tracked anymore — the headline sums the displayed stages only and
 * naming-kind runs never reach the list.
 */
function GraphCostPanel({ costs }: { costs: GraphCostSummary }) {
	const stageRows: [string, GraphCostSummary["stages"]["extraction"]][] = [
		["Extraction", costs.stages.extraction],
		["Audit", costs.stages.audit],
	];
	// The displayed figures come from displayCostTotals (naming excluded —
	// the pill and this panel must agree).
	const { unpricedRuns } = displayCostTotals(costs);
	return (
		<div className="w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-popover p-3 text-xs shadow-lg">
			<div className="mb-2 flex items-baseline justify-between">
				<span className="text-xs font-medium text-muted-foreground">
					Graph pipeline costs
				</span>
				<span className="font-ui text-foreground tabular-nums">
					{graphUsageLabel(costs)}
					{unpricedRuns > 0 && (
						<span className="text-muted-foreground">, {unpricedRuns} unpriced</span>
					)}
				</span>
			</div>
			<div className="flex flex-col gap-1">
				{stageRows.map(([label, stage]) => (
					<div key={label} className="flex items-baseline justify-between gap-2 text-xs">
						<span className="shrink-0 text-muted-foreground">{label}</span>
						<span className="min-w-0 text-right font-ui tabular-nums">
							{fmtRunCost(stage.runs - stage.unpricedRuns <= 0 ? null : stage.dollars)}
							{stage.unpricedRuns > 0 && stage.runs - stage.unpricedRuns > 0 && (
								<span className="text-muted-foreground"> +{stage.unpricedRuns} unpriced</span>
							)}
							<span className="text-muted-foreground">
								{" "}
								{fmtTokens(stage.tokens.inputTokens)} in / {fmtTokens(stage.tokens.outputTokens)} out
							</span>
						</span>
					</div>
				))}
			</div>
			<div className="mt-2 flex flex-col gap-0.5 border-t pt-2">
				{costs.runs.map((run) => (
						<div key={run.startedAt} className="flex items-baseline justify-between gap-2 text-xs">
							<span className="min-w-0 flex-1 truncate text-muted-foreground">
								<span className="text-foreground/70">{timeAgo(run.startedAt)}</span>{" "}
								{run.title}
								{run.merged && (
									<span className="text-muted-foreground">
										{" "}
										+{run.merged.nodes}n
									</span>
								)}
							</span>
							<span className="shrink-0 font-ui tabular-nums">{fmtRunCost(run.dollars)}</span>
						</div>
					))}
			</div>
		</div>
	);
}

/** Redesign (owner, 2026-10-27): the map is one quiet sentence below
 * recent lessons so starting or continuing a lesson stays primary. */
export function KnowledgeSummary({
	propositions,
	chains,
}: {
	propositions: number;
	chains: number;
}) {
	return (
		<p data-testid="knowledge-summary" className="font-prose text-sm italic text-muted-foreground">
			{propositions === 0 ? "Your map is empty. Import notes or start a session to fill it." : <>Your map holds {propositions} {propositions === 1 ? "idea" : "ideas"} and {chains} {chains === 1 ? "connection" : "connections"}.</>}
		</p>
	);
}

export function MinimalHome({
	children,
	chainSelectOpen = false,
	practiceSelection,
	onPracticeSelectionChange,
	onChainSelectClose,
}: {
	children: ReactNode;
	/** The lifted pick set drives the overlay's select mode (Done instead
	 * of the delete fence); the chip in home's composer reflects it. */
	chainSelectOpen?: boolean;
	practiceSelection?: ReadonlySet<string>;
	onPracticeSelectionChange?: (nodes: { id: string; name: string; statement: string }[]) => void;
	onChainSelectClose?: () => void;
}) {
	const router = useRouter();
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [costs, setCosts] = useState<GraphCostSummary | null>(null);
	const [chats, setChats] = useState<ChatListItem[]>([]);
	const [chainsOpen, setChainsOpen] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const readState = useCallback(() => {
		fetch("/api/graph")
			.then((res) => res.json() as Promise<GraphSnapshot>)
			.then(setSnapshot)
			.catch(() => {});
		fetch("/api/graph/costs")
			.then((res) => res.json() as Promise<GraphCostSummary>)
			.then(setCosts)
			.catch(() => {});
		fetch("/api/chats")
			.then((res) => res.json() as Promise<{ chats: ChatListItem[] }>)
			.then((body) => setChats(body.chats))
			.catch(() => {});
	}, []);
	useEffect(() => {
		readState();
	}, [readState]);
	useEffect(() => {
		window.addEventListener("lh:graph-revision", readState);
		return () => window.removeEventListener("lh:graph-revision", readState);
	}, [readState]);
	// Continue = sidebar rows (owner, 2026-10-27): a same-tab rename
	// updates this snapshot immediately, without waiting for a graph fetch.
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			setChats((prev) => prev.map((chat) => chat.id === id ? { ...chat, title } : chat));
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, []);

	// The practice chip opens the chain table in select mode.
	useEffect(() => {
		if (chainSelectOpen) setChainsOpen(true);
	}, [chainSelectOpen]);

	// Refetch even after incomplete imports: earlier writes and spend remain.
	const notesImport = useNotesImport({ onFinish: readState });
	const { importing, onImportFiles } = notesImport;

	const recent = [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);

	return (
		<div className="relative mx-auto max-w-[720px] px-5 pb-[calc(2rem+env(safe-area-inset-bottom))]">
			<input
				ref={fileInputRef}
				type="file"
				multiple
				accept=".md,.markdown,.txt"
				className="hidden"
				onChange={(e) => {
					onImportFiles(e.target.files);
					e.target.value = ""; // allow re-picking the same file
				}}
			/>

			{children}
			<section className="mt-9 border-t border-border pt-7">
				<h2 className="mb-2 font-title text-xl text-foreground">Continue</h2>
				{recent.length === 0 ? (
					<p className="py-3 text-sm text-muted-foreground">Start a session to see it here.</p>
				) : (
					<SessionList
						chats={recent}
						activeId={null}
						onOpen={(chat) => router.push(`/chat/${chat.id}`)}
						onRemoved={(id) => setChats((prev) => prev.filter((chat) => chat.id !== id))}
					/>
				)}
			</section>
			<div className="mt-7">
				<KnowledgeSummary
					propositions={snapshot?.propositions.length ?? 0}
					chains={snapshot?.chains.length ?? 0}
				/>
				<div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
					<button type="button" data-testid="open-chain-table" onClick={() => setChainsOpen(true)} className="min-h-11 underline underline-offset-2">Chains</button>
					<button type="button" data-testid="import-notes" disabled={importing} onClick={() => fileInputRef.current?.click()} className="min-h-11 underline underline-offset-2 disabled:opacity-50">{importing ? "Importing…" : "Import notes"}</button>
					{costs && costs.runs.length > 0 && <GraphCostControl costs={costs} />}
				</div>
				<NotesImportErrors errors={notesImport.errors} />
			</div>

			{/* Keep the chain table as the final child so it covers the home controls. */}
			<ChainTableOverlay
				open={chainsOpen && (snapshot?.propositions.length ?? 0) > 0}
				nodes={snapshot?.propositions ?? []}
				chains={snapshot?.chains ?? []}
				sessions={snapshot?.sessions ?? {}}
				fileSources={snapshot?.fileSources ?? {}}
				onClose={() => {
					setChainsOpen(false);
					onChainSelectClose?.();
				}}
				selectMode={chainSelectOpen}
				controlledSelection={practiceSelection}
				onSelectionChange={(ids) => {
					// Resolve ids → nodes against the live snapshot; the
					// caller holds the pick set (count + seed).
					const props = snapshot?.propositions ?? [];
					const picked: { id: string; name: string; statement: string }[] = [];
					for (const id of ids) {
						const n = props.find((node) => node.id === id);
						if (n) picked.push({ id: n.id, name: n.name, statement: n.statement });
					}
					onPracticeSelectionChange?.(picked);
				}}
			/>
		</div>
	);
}
