"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MermaidErrorComponentProps } from "streamdown";

/**
 * Fallback for mermaid diagrams that fail to parse — wired via Streamdown's
 * `mermaid.errorComponent`. Replaces the default light-themed red box with a
 * card matching the app: the error, the source in a details block (so a
 * broken diagram doesn't flood the transcript), and a retry.
 */
export const MermaidError = ({
	chart,
	error,
	retry,
	className,
}: MermaidErrorComponentProps & { className?: string }) => (
	<div
		className={cn(
			"my-4 rounded-lg border border-border p-4 font-ui",
			className,
		)}
		data-streamdown="mermaid-error"
	>
		<p className="text-sm font-medium text-destructive">
			Diagram failed to render
		</p>
		<p className="mt-1 break-words text-xs text-muted-foreground">
			{error}
		</p>
		<details className="mt-3">
			<summary className="flex min-h-11 cursor-pointer items-center text-xs text-muted-foreground">
				Show diagram source
			</summary>
			<pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground">
				{chart}
			</pre>
		</details>
		<Button className="mt-3" onClick={retry} size="sm" variant="outline">
			Retry
		</Button>
	</div>
);
