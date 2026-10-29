import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/** A single ink fill follows the current theme, never a grading-color ramp. */
export function confidenceRailStyle(value: number): CSSProperties {
	return { width: `${value}%` };
}

/** The static rail — the slider's look, disc removed. */
export function ConfidenceRail({ value, className }: { value: number; className?: string }) {
	return (
		<div aria-hidden data-testid="confidence-rail" className={cn("h-1.5 w-full rounded-full bg-muted", className)}>
			<div className="h-full rounded-full bg-primary" style={confidenceRailStyle(value)} />
		</div>
	);
}
