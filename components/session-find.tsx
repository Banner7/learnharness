"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { stepSessionMatch } from "@/src/core";
import {
	sameSessionRange, sessionFindRanges, sessionRangeIdentity, type SessionRangeIdentity,
} from "@/components/session-find-dom";
import { scrollSessionTarget, type SessionScrollContext } from "@/components/session-navigation";

export const SESSION_FIND_HIGHLIGHT = "lh-session-find";
export const SESSION_FIND_ACTIVE_HIGHLIGHT = "lh-session-find-active";

/** ::highlight() rules live OUTSIDE globals.css on purpose: the PostCSS/
 *  Tailwind v4 pipeline rejects the Custom Highlight pseudo-element as a
 *  parse error, which downed the whole stylesheet. A tiny <style> element,
 *  injected once on first client mount, ships them verbatim. */
const FIND_STYLE_ID = "lh-session-find-style";
export function injectFindStyles(): void {
	if (document.getElementById(FIND_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = FIND_STYLE_ID;
	style.textContent = `
::highlight(${SESSION_FIND_HIGHLIGHT}) { background-color: color-mix(in oklab, var(--primary) 25%, transparent); }
::highlight(${SESSION_FIND_ACTIVE_HIGHLIGHT}) { background-color: var(--primary); color: var(--primary-foreground); }`;
	document.head.appendChild(style);
}

export function clearSessionFindHighlights(): void {
	if (typeof CSS === "undefined") return;
	CSS.highlights?.delete(SESSION_FIND_HIGHLIGHT);
	CSS.highlights?.delete(SESSION_FIND_ACTIVE_HIGHLIGHT);
}

function publishHighlights(ranges: readonly Range[], index: number): void {
	if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
	// Avoid a huge argument spread when a short query matches many times.
	const all = new Highlight();
	for (const range of ranges) all.add(range);
	CSS.highlights.set(SESSION_FIND_HIGHLIGHT, all);
	const active = new Highlight();
	active.priority = 1;
	if (ranges[index]) active.add(ranges[index]!);
	CSS.highlights.set(SESSION_FIND_ACTIVE_HIGHLIGHT, active);
}


/** Mounted for the lifetime of ONE Chat (which is keyed by chatId). Closing
 * keeps the query/reading position; changing sessions resets all local state.
 * The bar lives outside scopeRef, so it never finds its own query or count. */
export function SessionFind({ scopeRef, scrollContextRef, open, onOpenChange }: {
	scopeRef: RefObject<HTMLDivElement | null>;
	scrollContextRef: RefObject<SessionScrollContext | null>;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [query, setQuery] = useState("");
	const [result, setResult] = useState({ index: -1, count: 0 });
	useEffect(injectFindStyles, []);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const rangesRef = useRef<Range[]>([]);
	const indexRef = useRef(-1);
	const identityRef = useRef<SessionRangeIdentity | null>(null);
	const lastQueryRef = useRef<string | null>(null);

	const close = () => {
		clearSessionFindHighlights();
		onOpenChange(false);
	};
	useEffect(() => {
		if (open) inputRef.current?.focus({ preventScroll: true });
	}, [open]);


	useEffect(() => {
		if (!open || !scopeRef.current) return;
		const scope = scopeRef.current;
		let frame: number | null = null;
		const refresh = (selectFirst: boolean) => {
			const ranges = sessionFindRanges(scope, query);
			let index = selectFirst ? 0 : ranges.findIndex((range) => sameSessionRange(range, identityRef.current));
			if (index < 0) index = Math.max(0, Math.min(indexRef.current, ranges.length - 1));
			if (!ranges.length) index = -1;
			rangesRef.current = ranges;
			indexRef.current = index;
			identityRef.current = ranges[index] ? sessionRangeIdentity(ranges[index]!) : null;
			setResult((old) => old.index === index && old.count === ranges.length ? old : { index, count: ranges.length });
			publishHighlights(ranges, index);
			if (selectFirst && ranges[index]) scrollSessionTarget(ranges[index]!, scope, scrollContextRef.current);
		};
		// New queries start at the session's first match. Reopening the retained
		// query or receiving streamed content only refreshes; neither yanks scroll.
		refresh(lastQueryRef.current !== query);
		lastQueryRef.current = query;
		const schedule = () => {
			if (frame !== null) return;
			frame = window.requestAnimationFrame(() => { frame = null; refresh(false); });
		};
		const observer = new MutationObserver(schedule);
		observer.observe(scope, { subtree: true, childList: true, characterData: true, attributes: true,
			attributeFilter: ["hidden", "style", "class", "data-state", "aria-expanded"] });
		window.addEventListener("resize", schedule);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", schedule);
			if (frame !== null) window.cancelAnimationFrame(frame);
			clearSessionFindHighlights();
		};
	}, [open, query, scopeRef, scrollContextRef]);

	// Also clear on a session switch when Find was already closed.
	useEffect(() => clearSessionFindHighlights, []);

	const step = (direction: 1 | -1) => {
		const ranges = rangesRef.current;
		const index = stepSessionMatch(indexRef.current, ranges.length, direction);
		indexRef.current = index;
		identityRef.current = ranges[index] ? sessionRangeIdentity(ranges[index]!) : null;
		setResult({ index, count: ranges.length });
		publishHighlights(ranges, index);
		if (ranges[index] && scopeRef.current) scrollSessionTarget(ranges[index]!, scopeRef.current, scrollContextRef.current);
	};

	if (!open) return null;
	const buttonClass = "flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40";
	return (
		<div
			role="search"
			aria-label="Session Find"
			data-testid="session-find"
			className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border bg-background px-2 text-sm"
		>
			<SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
			<input
				ref={inputRef}
				aria-label="Find in session"
				placeholder="Find in session…"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				spellCheck={false}
				className="lh-input min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
			/>
			<output aria-live="polite" data-testid="session-find-count" className="shrink-0 text-xs tabular-nums text-muted-foreground">
				{query ? `${result.index + 1}/${result.count}` : ""}
			</output>
			<button type="button" aria-label="Previous match" title="Previous match" className={buttonClass}
				disabled={!result.count} onMouseDown={(event) => event.preventDefault()} onClick={() => step(-1)}>
				<ChevronUpIcon className="size-4" aria-hidden />
			</button>
			<button type="button" aria-label="Next match" title="Next match" className={buttonClass}
				disabled={!result.count} onMouseDown={(event) => event.preventDefault()} onClick={() => step(1)}>
				<ChevronDownIcon className="size-4" aria-hidden />
			</button>
			<button type="button" aria-label="Close Find" title="Close Find" className={buttonClass} onClick={close}>
				<XIcon className="size-4" aria-hidden />
			</button>
		</div>
	);
}
