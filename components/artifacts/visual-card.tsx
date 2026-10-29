"use client";

import { useContext, useState } from "react";
import { ChatActionsContext } from "@/components/chat";
import { DownloadIcon, MaximizeIcon } from "lucide-react";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { Toggle } from "@/components/settings/controls";
import { useSessionMermaid } from "@/components/session-overlay";
import { downloadFile } from "@/components/artifacts/download";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import type { ArtifactPartProps, VisualResult } from "@/src/core";

/**
 * Visual artifact card (W6 → ack protocol): the tool part's output is the
 * dispatch ack, so the tool-call box is the DispatchCard (live status via
 * the chat view's jobs feed). The SVG itself renders from the steer message
 * (sub-agent result delivery) via VisualOutputCard.
 *
 * The SVG is model-authored for the learner's own machine (their own teacher
 * wrote it, verified by looking) — dangerouslySetInnerHTML is acceptable
 * here, with a cheap hygiene pass (sanitizeSvg: strip <script> blocks, on*
 * handlers, and javascript:/data:text/html URLs) since it lands in the
 * app's DOM.
 */

/** Cheap SVG hygiene — not a full sanitizer, just removing the obvious exec vectors. */
export function sanitizeSvg(svg: string): string {
	return svg
		.replace(/<script[\s\S]*?<\/script\s*>/gi, "")
		.replace(/<script[^>]*\/?>/gi, "")
		.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/(href|xlink:href)\s*=\s*(?:"\s*(?:javascript|data:text\/html)[^"]*"|'\s*(?:javascript|data:text\/html)[^']*'|(?:javascript|data:text\/html)[^\s>]*)/gi, "");
}

/** The svg root's DECLARED width in px, when there is one — the natural
 *  size the card displays at instead of stretching to full width (owner,
 *  2026-10-07). %, em, "auto", or a missing attribute → null (the caller
 *  falls back to full-width). Pure. */
export function svgNaturalWidth(svg: string): number | null {
	const m = /<svg\b[^>]*?\bwidth\s*=\s*["']([^"']+)["'][^>]*>/i.exec(svg);
	if (!m) return null;
	const value = m[1]!.trim();
	const px = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value);
	if (!px) return null;
	const n = Number.parseFloat(px[1]!);
	return Number.isFinite(n) && n > 0 ? n : null;
}

export function VisualCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="visual" />;
}

/** The figure itself — exported: the steer card renders the delivered artifact. */
export function VisualOutputCard({
	output,
	messageId,
	initialInverted = false,
}: {
	output: unknown;
	messageId?: string;
	initialInverted?: boolean;
}) {
	const result = output as VisualResult | undefined;
	const overlay = useSessionMermaid();
	const actions = useContext(ChatActionsContext);
	// Brightness inversion (owner, 2026-10-07): the switch state PERSISTS on
	// the steer record (details.ui.inverted) — seeded here, written through
	// the silent artifact-ui route on toggle; without a chat page (tests,
	// previews) it stays local-only. The toggled state also feeds the
	// fullscreen overlay (openFigure).
	const [inverted, setInverted] = useState(initialInverted);
	const toggleInverted = (next: boolean) => {
		setInverted(next);
		if (!actions?.chatId || !messageId) return;
		void fetch(`/api/chats/${actions.chatId}/artifact-ui`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId, inverted: next } }),
		}).catch(() => {});
	};
	const natural = result && typeof result.svg === "string" ? svgNaturalWidth(result.svg) : null;
	if (!result || typeof result.svg !== "string") {
		return (
			<div className="rounded-lg border border-border p-4 font-ui text-sm text-muted-foreground">
				Figure completed, but the result could not be displayed.
			</div>
		);
	}
	const failed = result.svg.length === 0;
	if (failed) {
		return (
			<div className="rounded-lg border border-border p-4 font-ui text-foreground" data-testid="visual-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
					Figure
					<span className="text-destructive">Failed</span>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{result.notes ?? "The figure could not be drawn."}</p>
			</div>
		);
	}
	return (
		/* NO CARD CHROME (owner round, 2026-10-07): the figure is document
		   material — no border, no padding box. Image first, then the CAPTION
		   ROW below: "Figure" left, the controls right, both edges following
		   the IMAGE's own width (the wrapper carries the natural-sizing law,
		   so the row hugs a centered narrow figure, not the column). */
		<div
			className={
				natural !== null
					? "my-4 mx-auto w-fit max-w-full"
					: "my-4 w-full"
			}
			data-testid="visual-card"
		>
			{/* Redesign (owner, 2026-10-27): a declared-width SVG retains its
			    natural size, while the backing uses the card token in either
			    mode and the inversion control still flips the figure. */}
			<div
				className={
					natural !== null
						? "w-fit max-w-full overflow-hidden rounded-md bg-card [&_svg]:h-auto [&_svg]:max-w-full"
						: "w-full overflow-hidden rounded-md bg-card [&_svg]:h-auto [&_svg]:w-full"
				}
				style={{ filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined }}
				dangerouslySetInnerHTML={{ __html: sanitizeSvg(result.svg) }}
				data-testid="visual-svg"
			/>
			<div className="mt-2 flex items-center justify-between gap-2">
				<div className="text-xs font-medium text-muted-foreground">Figure</div>
				<div className="flex items-center gap-1.5">
					{/* The invert affordance (owner round, 2026-10-07): the disc IS
					    the half-filled contrast circle; the tooltip names it. */}
					<Toggle
						checked={inverted}
						onChange={toggleInverted}
						label="Invert figure brightness"
						title="Invert colors"
						discIcon={<InvertDiscIcon className="size-3" />}
					/>
					<button
						type="button"
						aria-label="Download figure as SVG"
						title="Download as SVG"
						onClick={() => downloadFile("figure.svg", result.svg, "image/svg+xml")}
						data-testid="visual-download"
						className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DownloadIcon className="size-3.5" />
					</button>
					{overlay && (
						<button
							type="button"
							aria-label="Open figure fullscreen"
							title="Open fullscreen"
							onClick={() => overlay.openFigure(result.svg, inverted)}
							data-testid="visual-open"
							className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
