"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { PathInput } from "@/components/path-input";

/**
 * The reading-thinking field (owner design 2026-10-03, "two questions per
 * teaching unit"): a quiet textarea for thinking WHILE READING the
 * teaching prose — the same transfer channel the question dock's "Your
 * thinking" gives the answer, opened one phase earlier. It mounts while a
 * teach-phase check waits behind its reveal (the same cue that collapses
 * the check), rides the answer as the separate `readingThinking`
 * channel, and disappears with the question.
 *
 * Local keystroke state (upstream 2d94eab + c1361d1, ported 2026-11-01):
 * typing re-renders only this field; `revision` announces parent resets,
 * and the ref holds every edit synchronously before React commits.
 */
export function ReadingThinkingField({
	value,
	revision,
	onChange,
}: {
	value: string;
	revision: number;
	onChange: (v: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	const draftRef = useRef(value);
	useLayoutEffect(() => { draftRef.current = value; setDraft(value); }, [revision, value]);
	const applyDraft = useCallback((next: string) => {
		draftRef.current = next;
		setDraft(next);
		onChange(next);
	}, [onChange]);
	return (
		<div
			data-testid="reading-thinking-field"
			className="pointer-events-auto mb-2 rounded-md border border-border bg-card px-3 py-2 transition-colors focus-within:border-primary"
		>
			<div className="pb-1 text-xs font-medium text-muted-foreground">
				Thinking while reading
			</div>
			<PathInput
				value={draft}
				onValueChange={applyDraft}
				/* Redesign (owner, 2026-10-27): retain vertical padding so the
				   browser's font box does not produce a permanent scrollbar. */
				placeholder="Whatever comes to mind as you read."
				className="field-sizing-content lh-input max-h-40 w-full resize-none bg-transparent py-0.5 font-ui outline-none placeholder:text-muted-foreground"
			/>
		</div>
	);
}
