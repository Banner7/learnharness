"use client";

import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { cn } from "@/lib/utils";
import { PathText } from "@/components/file-path-chip";

/** Redesign (owner, 2026-10-27): a learner's optional reasoning is a
 * quiet disclosure with a narrow learner-colored rail, distinct from
 * the tutor's unbordered Thinking disclosure. Transcript rows open by
 * default; in-card rows remain on their card's own surface. */

export function ThinkingBlock({
	label = "Your thinking",
	text,
	testId,
	dataCommit,
	defaultOpen = false,
	inCard = false,
}: {
	label?: string;
	text: string;
	testId?: string;
	/** The practice marker's register flag (commit vs nudge). */
	dataCommit?: boolean;
	/** Transcript rows arrive expanded (owner, 2026-10-07). */
	defaultOpen?: boolean;
	/** On the card's own background, avoid any extra surface fill. */
	inCard?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		/* The rail identifies learner-authored reasoning without restoring
		   the old full-width band or uppercase author labels. */
		<div
			data-testid={testId}
			data-commit={dataCommit === undefined ? undefined : dataCommit ? "true" : "false"}
			className={cn(
				"my-2 w-full py-1 font-ui text-xs text-muted-foreground",
				inCard ? "" : "bg-transparent",
			)}
		>
			<button
				type="button"
				data-testid={testId ? `${testId}-trigger` : undefined}
				onClick={(e) => {
					setOpen((v) => !v);
					blurAfterPointerClick(e);
				}}
				aria-expanded={open}
				className="flex min-h-11 w-full items-center gap-2 font-medium text-muted-foreground transition-colors hover:text-foreground"
			>
				{label}
				<ChevronDownIcon className={cn("size-4 shrink-0 transition-transform", open ? "rotate-180" : "rotate-0")} />
			</button>
			{open && (
				<span className="lh-learner mt-1.5 block whitespace-pre-wrap"><PathText text={text} /></span>
			)}
		</div>
	);
}
