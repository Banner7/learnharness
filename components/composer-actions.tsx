"use client";

import type { ReactNode } from "react";
import { DumbbellIcon } from "lucide-react";

/** Home and the draft share one wrapping node-picker action row. */
export function ComposerActions({ picker }: { picker?: ReactNode }) {
	if (!picker) return null;
	return (
		<div
			data-testid="composer-actions"
			className="pointer-events-auto mb-2 flex flex-wrap items-center justify-start gap-2"
		>
			{picker}
		</div>
	);
}

/** These are node counts, even when a whole chain supplied the selection. */
export function NodePickerControl({ count, onOpen, onClear }: {
	count: number;
	onOpen?: () => void;
	onClear?: () => void;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				data-testid="practice-props-chip"
				onClick={onOpen}
				className={
					"flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md px-3 text-xs transition-colors " +
					(count > 0
						? "bg-muted text-foreground hover:bg-accent"
						: "text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<DumbbellIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				{count > 0 ? `${count} ${count === 1 ? "node" : "nodes"} selected` : "Pick nodes"}
			</button>
			{count > 0 && (
				<button
					type="button"
					data-testid="practice-props-clear"
					onClick={onClear}
					className="min-h-11 cursor-pointer rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
		</div>
	);
}
