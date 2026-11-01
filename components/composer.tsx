"use client";

import { CornerDownLeftIcon, SquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { tap } from "@/lib/haptics";
import { HapticLabel } from "@/components/ui/haptic";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PathInput } from "@/components/path-input";

/**
 * The chat composer is the content row; the chat view owns its persistent
 * dock shell so turn-state changes never remount the input.
 */

/**
 * Session composer with local keystroke state (upstream 2d94eab). The
 * owning Chat keeps the current draft in a ref for send, so typing doesn't
 * rerender the transcript; `revision` signals explicit parent-driven resets.
 */
export function ChatSessionComposer({
	value,
	revision,
	onChange,
	sendAllowed,
	...rest
}: Omit<React.ComponentProps<typeof Composer>, "canSend" | "variant" | "actions"> & {
	revision: number;
	sendAllowed: boolean;
}) {
	const [draft, setDraft] = useState(value);
	useLayoutEffect(() => { setDraft(value); }, [revision, value]);
	const applyDraft = useCallback((next: string) => {
		setDraft(next);
		onChange(next);
	}, [onChange]);
	return <Composer {...rest} value={draft} onChange={applyDraft} canSend={sendAllowed && draft.trim().length > 0} />;
}

export function Composer({
	busy,
	value,
	onChange,
	onSend,
	onStop,
	canSend,
	autoFocus,
	inputRef,
	placeholder = "Ask, answer, or steer the lesson",
	nextProblem = false,
	onNext,
	variant = "session",
	actions,
}: {
	busy: boolean;
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	onStop: () => void;
	canSend: boolean;
	autoFocus?: boolean;
	/** Optional editor focus ref. */
	inputRef?: React.RefObject<HTMLDivElement | null>;
	/** Placeholder text varies between active and new sessions. */
	placeholder?: string;
	/** Practice pause offers a Next problem button. */
	nextProblem?: boolean;
	/** Dispatches the next practice problem. */
	onNext?: () => void;
	/** Home keeps its mode switch and Start action inside the same composer. */
	variant?: "home" | "session";
	actions?: ReactNode;
}) {
	const localInputRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// Desktop composer shortcut (2026-10-31): leave phone keyboard
		// behavior and every already-focused editable field untouched.
		const focusComposer = (event: KeyboardEvent) => {
			if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || !window.matchMedia("(min-width: 1100px)").matches) return;
			const target = event.target;
			if (target instanceof Element && (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") || target.closest('[role="textbox"]'))) return;
			const editor = inputRef?.current ?? localInputRef.current;
			if (!editor) return;
			event.preventDefault();
			editor.focus();
		};
		window.addEventListener("keydown", focusComposer);
		return () => window.removeEventListener("keydown", focusComposer);
	}, [inputRef]);
	const act = () => {
		if (busy && !canSend) onStop();
		else if (canSend) onSend();
		else if (nextProblem) onNext?.();
	};
	return (
		<form
			data-testid="composer"
			className={variant === "home" ? "rounded-xl border border-border bg-card p-3" : "flex items-end gap-1.5 p-1.5"}
			onSubmit={(e) => {
				e.preventDefault();
				act();
			}}
		>
			<PathInput
				ref={inputRef ?? localInputRef}
				value={value}
				onValueChange={onChange}
				defaultDropTarget
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey && canSend) {
						e.preventDefault();
						onSend();
					}
				}}
				placeholder={placeholder}
				autoFocus={autoFocus}
				className={cn("field-sizing-content lh-input max-h-48 resize-none bg-transparent outline-none placeholder:text-muted-foreground", variant === "home" ? "min-h-28 w-full text-lg" : "min-h-10 flex-1 px-2.5 py-2 text-base")}
			/>
			{variant === "home" ? actions : nextProblem && !busy && !canSend ? (
					<button
						type="submit"
						onClick={() => tap()}
						data-testid="next-problem-button"
						aria-label="Next problem"
						className="relative flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:opacity-90"
					>
						Next problem
						<HapticLabel />
					</button>
				) : (
					<button
						type="submit"
						onClick={() => { if (canSend) tap(); }}
						aria-label={busy && !canSend ? "Stop" : "Send"}
						disabled={!busy && !canSend}
						className={cn(
							"relative flex size-11 shrink-0 items-center justify-center rounded-full transition-colors",
							busy && !canSend
								? "bg-secondary text-foreground hover:bg-accent"
								: "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40",
						)}
					>
						{busy && !canSend ? <SquareIcon className="size-4" /> : <CornerDownLeftIcon className="size-5" />}
						{canSend && <HapticLabel />}
					</button>
				)}
		</form>
	);
}
