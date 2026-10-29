"use client";

import { PathInput } from "@/components/path-input";

/**
 * The reading-thinking field (owner design 2026-10-03, "two questions per
 * teaching unit"): a quiet textarea for thinking WHILE READING the
 * teaching prose — the same transfer channel the question dock's "Your
 * thinking" gives the answer, opened one phase earlier. It mounts while a
 * teach-phase check waits behind its reveal (the same cue that collapses
 * the check), rides the answer as the separate `readingThinking`
 * channel, and disappears with the question.
 */
export function ReadingThinkingField({
	value,
	onChange,
}: {
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<div
			data-testid="reading-thinking-field"
			className="pointer-events-auto mb-2 rounded-md border border-border bg-card px-3 py-2 transition-colors focus-within:border-primary"
		>
			<div className="pb-1 text-xs font-medium text-muted-foreground">
				Thinking while reading
			</div>
			<PathInput
				value={value}
				onValueChange={onChange}
				/* Redesign (owner, 2026-10-27): retain vertical padding so the
				   browser's font box does not produce a permanent scrollbar. */
				placeholder="Whatever comes to mind as you read."
				className="field-sizing-content lh-input max-h-40 w-full resize-none bg-transparent py-0.5 font-ui outline-none placeholder:text-muted-foreground"
			/>
		</div>
	);
}
