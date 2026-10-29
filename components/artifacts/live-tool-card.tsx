"use client";

import { ChevronRight } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { toolActivityLabel } from "@/src/core";
import type { ArtifactPartProps } from "@/src/core";

/**
 * The LIVE tool-input card (owner, streaming round 2026-10-01): what a
 * tool call looks like while the agent WRITES it. A tool part sits in
 * `input-streaming` for its whole execution (the bridge defers
 * input-available to tool_execution_end), so this card IS the working
 * state — a spinner and a plain activity label in the header, with
 * streaming input available on expand. When the call settles, the
 * artifact registry replaces this with the result card.
 *
 * Redesign (owner, 2026-10-27): the braille cell is the working
 * indicator; additional animated text would only impair reading.
 */
interface StreamingToolPart {
	type: string;
	state: string;
	toolCallId: string;
	input?: unknown;
}

export function LiveToolCard({ part }: ArtifactPartProps) {
	const p = part as StreamingToolPart;
	const tool = p.type.replace(/^tool-/, "");
	const inp = (p.input ?? {}) as Record<string, unknown>;
	// The headline argument (ToolCallCard's rule, shown as given): path for
	// read/ls, pattern for find/grep, session for list_propositions.
	let arg = "";
	if (typeof inp.path === "string" && inp.path) arg = inp.path;
	else if (typeof inp.pattern === "string" && inp.pattern) arg = inp.pattern;
	else if (typeof inp.session === "string" && inp.session) arg = inp.session;

	const hasInput = p.input != null && Object.keys(inp).length > 0;

	return (
		<details
			data-testid="live-tool-card"
			data-tool={tool}
			className="group my-1 w-full max-w-2xl select-none"
		>
			<summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg border border-border px-3 font-ui text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
				<BrailleSpinner label={`${toolActivityLabel(tool)} — live`} />
				<span>{toolActivityLabel(tool)}</span>
				{arg && <span className="truncate">{arg}</span>}
				<ChevronRight className="size-3 shrink-0 opacity-50 transition-transform group-open:rotate-90" />
			</summary>
			<div className="mt-1 rounded-lg border border-border p-3 font-ui text-xs">
				<div className="mb-1 font-medium text-muted-foreground">Input (streaming)</div>
				<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
					{hasInput ? JSON.stringify(p.input, null, 2) : "…"}
				</pre>
			</div>
		</details>
	);
}
