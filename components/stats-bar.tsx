"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CLAUDE_CODE_PROVIDER, type CliContextWindow, type SessionPricing, type TurnUsage } from "@/src/core";
import { formatTokens, formatUsd, planCostLabel, prettyModel } from "@/components/usage-format";
import { ModelControl, catalogLimits, useModelCatalog } from "@/components/model-picker";

export function formatContextMeasurement(tokens: number | null, limit: number | null): string {
	const numerator = tokens === null ? "?" : formatTokens(tokens);
	return limit === null ? numerator : `${numerator} / ${formatTokens(limit)}`;
}

/** CLI aliases have no global catalog limit: only this session's matching
 * response can supply a denominator. Other providers keep their catalog join. */
export function contextLimitForModel(model: string | undefined, limits: ReadonlyMap<string, number> | undefined,
	cliWindow: CliContextWindow | null = null): number | null {
	if (!model) return null;
	if (model.startsWith(`${CLAUDE_CODE_PROVIDER}:`)) return cliWindow?.model === model ? cliWindow.tokens : null;
	return limits?.get(model) ?? null;
}

/**
 * The below-composer stats bar (wave 4 observability): the session's
 * money/context footprint as one quiet row beneath the composer —
 * LEFT-aligned: context window + session cost; RIGHT-aligned: model +
 * thinking level. Clicking the left side opens the per-turn detail popover.
 *
 *  Pre-chat views (home, /chat/new) render NO left side at all (owner,
 *  wave 7 sweep: the knowledge-context budget slider that used to live
 *  there died with the injection; a "— · —" summary over an empty
 *  popover is pure noise).
 *
 * Spending arrives already priced by the server through Pi's catalog and
 * calculator. Missing cost stays "—", never fake zero. Context is a separate
 * completed-conversation measurement, never a money-log/summarizer fold or
 * transcript estimate. Its denominator follows the selected model, from the
 * catalog or the session's CLI report; model changes preserve the numerator.
 * Successful compaction clears the numerator and any old CLI report.
 */
export function StatsBar({
	turns,
	contextTokens = null,
	cliContextWindow = null,
	pricing,
	chatId,
	leadingSlot,
}: {
	turns: TurnUsage[];
	contextTokens?: number | null;
	cliContextWindow?: CliContextWindow | null;
	pricing?: SessionPricing;
	/** The bound session (per-session models, owner 2026-09-28): present
	 *  on the in-session bar — the model control binds THE SESSION'S own
	 *  record; absent on the draft surfaces, where it binds the strong
	 *  slot (the new-session default). */
	chatId?: string;
	/** The row's LEFT edge (practice sessions, 2026-10-04): the home
	 *  composer's teach | practice switch rides here — before the session
	 *  data (which renders nothing pre-chat on that surface). */
	leadingSlot?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [selectedModel, setSelectedModel] = useState<string | undefined>();
	// Close the popover on pointerdown outside the bar.
	const barRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [open]);
	// The picker reports its effective selection. CLI windows are session-
	// scoped; unknown metadata always means usage-only, never a guessed maximum.
	const { catalog } = useModelCatalog();
	const limits = useMemo(() => (catalog ? catalogLimits(catalog) : undefined), [catalog]);
	const limit = contextLimitForModel(selectedModel, limits, cliContextWindow);
	const contextLabel = formatContextMeasurement(contextTokens, limit);
	const { cost = 0, unpriced = turns.length } = pricing ?? {};
	// Honest cost: show dollars only when at least one turn priced;
	// otherwise "—" (never a fake $0.0000).
	const pricedCount = turns.length - unpriced;
	const cliBilled = turns.some((turn) => turn.model.startsWith(`${CLAUDE_CODE_PROVIDER}:`));
	const dollars = planCostLabel(pricedCount > 0 ? cost : null);
	const costLabel = cliBilled ? pricedCount > 0 ? `${dollars} + CLI` : "CLI" : dollars;

	return (
		<div
			data-testid="stats-bar"
			// pointer-events-auto: the sticky composer wrapper is pointer-events-none
			// (so its transparent gradient area never blocks scrolling) — this row
			// must re-enable events or every control on it is dead (the model-
			// control wave caught this live: buttons rendered, clicks never landed).
			className="pointer-events-auto relative flex flex-wrap items-center justify-between gap-x-3 px-3 pt-1 text-xs text-muted-foreground"
		>
			{/* The summary button + its popover: the popover anchors to this
			    wrapper, CENTERED over the button itself (owner, stats round 2)
			    — not over the whole bar row, which made it line up oddly. The
			    outside-close ref anchors HERE too (owner, round 3): on the whole
			    bar it wrapped the model control, so clicking model/thinking never
			    counted as outside — the asymmetry the owner observed. */}
			{/* The leading slot (2026-10-04): the leftmost control surface —
			    the home composer's mode switch. */}
			{leadingSlot}
			{/* The left side: the session-data summary — only once a session
			    exists (turns). Pre-chat renders nothing (see the header). */}
			{(chatId || turns.length > 0) && (
			<div ref={barRef} className="relative min-w-0">
				{/* No tooltip — the numbers describe themselves and the popover
			    speaks on click (owner, subtlety round 2026-09-25). */}
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				data-testid="stats-summary"
				className="flex min-h-11 items-center gap-3 tabular-nums transition-colors hover:text-foreground"
			>
				<span data-testid="stats-context">
					{contextLabel}
				</span>
				<span data-testid="stats-cost">{costLabel}</span>
			</button>
				{open && (
					<div
						data-testid="stats-detail"
						className="absolute bottom-full left-1/2 z-40 mb-1.5 w-72 -translate-x-1/2 rounded-lg border border-border bg-popover p-3 text-xs shadow-lg"
					>
						<div className="mb-2 text-xs font-medium text-muted-foreground">
							Session stats
						</div>
						<div className="flex flex-col gap-1 text-muted-foreground">
							<div className="flex justify-between gap-2">
								<span>Context (last call)</span>
								<span className="tabular-nums text-card-foreground">
									{contextLabel}
								</span>
							</div>
							{selectedModel?.startsWith(`${CLAUDE_CODE_PROVIDER}:`) && (
								<p>Window reported by Claude Code; may be lower for auto-compaction.</p>
							)}
							<div className="flex justify-between gap-2">
								<span>Total cost</span>
								<span className="tabular-nums text-card-foreground">{costLabel}</span>
							</div>
							{unpriced > 0 && (
								<div className="flex justify-between gap-2">
									<span>Unpriced turns</span>
									<span className="tabular-nums text-card-foreground">{unpriced}</span>
								</div>
							)}
						</div>
						{turns.length > 0 && (
							<>
								<div className="mb-1 mt-2.5 border-t pt-2 text-xs font-medium text-muted-foreground">
									Turns
								</div>
								<ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
									{turns.map((turn, i) => {
										const c = pricing?.turnCosts[turn.id] ?? null;
										return (
											<li key={`${turn.messageId}-${i}`} className="flex items-center justify-between gap-2">
												<span className="truncate text-muted-foreground">
													#{i + 1} {prettyModel(turn.model, true)}
												</span>
												<span className="flex shrink-0 items-center gap-2 tabular-nums text-card-foreground">
													<span className="text-muted-foreground">{turn.steps.length} steps</span>
													<span>{turn.model.startsWith(`${CLAUDE_CODE_PROVIDER}:`) ? "CLI" : c === null ? "—" : formatUsd(c)}</span>
												</span>
											</li>
										);
									})}
								</ul>
							</>
						)}
					</div>
				)}
			</div>
			)}
			{/* The model + thinking control — one controller for the conversation
			    agents (prober/teacher); the record's `turns` above still folds
			    the ACTUAL models billed, regardless of what the picker says. */}
			<ModelControl chatId={chatId} onModelChange={setSelectedModel} />
		</div>
	);
}
