import type { Phase3 } from "@/src/core";

/** Phase boundaries stay in the transcript even though the phone header
 * shows phase information accessibly rather than as a separate chip.
 * Redesign (owner, 2026-10-27): a quiet sentence-case seam suits both modes. */

/** Sentence-case labels for transcript boundaries. */
const PHASE_LABEL: Record<Phase3, string> = {
	probe: "Probing",
	plan: "Planning",
	teach: "Teaching",
};


/**
 * The transcript boundary marks a phase transition with a hairline and
 * sentence-case label; the plan seam retains its node count.
 * Null for probe (defensive — the fold never emits a probe transition
 * after the start).
 */
export function PhaseDivider({ phase, nodeCount }: { phase: Phase3; nodeCount?: number }) {
	if (phase === "probe") return null;
	const label =
		phase === "plan" && nodeCount
			? `Plan · ${nodeCount} node${nodeCount === 1 ? "" : "s"}`
			: PHASE_LABEL[phase];
	return (
		<div className="my-4 flex w-full items-center gap-3 font-ui" data-testid={`phase-divider-${phase}`}>
			<span className="h-0 flex-1 border-t border-border" aria-hidden />
			<span className="text-xs font-medium text-muted-foreground">
				{label}
			</span>
			<span className="h-0 flex-1 border-t border-border" aria-hidden />
		</div>
	);
}

/**
 * The node count for a plan seam: the first plan-op tree output in the
 * message that carries the seam (the plan_init that made the phase flip).
 * Structural slice of a UI message, same shape-of-shapes as core/phases.ts.
 */
export function planNodeCount(
	message: { parts: ReadonlyArray<{ type: string; state?: string; output?: unknown; [k: string]: unknown }> },
): number | undefined {
	for (const part of message.parts) {
		if (!part.type.startsWith("tool-plan_") || part.state !== "output-available") continue;
		const tree = (part.output as { tree?: { nodes?: unknown[] } } | undefined)?.tree;
		if (tree && Array.isArray(tree.nodes) && tree.nodes.length > 0) return tree.nodes.length;
	}
	return undefined;
}
