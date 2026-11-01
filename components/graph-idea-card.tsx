"use client";

import { Link } from "wouter";
import { FileTextIcon } from "lucide-react";
import { propositionSessionHref, type GraphNode } from "@/src/core";

/**
 * The idea detail card (owner, 2026-10-04; shared with the phone graph,
 * 2026-11-01): a proposition's name, statement and click-through provenance.
 * The desktop canvas anchors it beside its node; the phone graph shows it in
 * a bottom sheet. Presentational only — the caller owns placement and chrome.
 */
export function GraphIdeaCard({
	node,
	sourceIds,
	sessions,
	fileSources,
}: {
	node: GraphNode;
	sourceIds: string[];
	sessions: Record<string, string>;
	fileSources: Record<string, string>;
}) {
	return (
		<div>
			<div className="text-sm font-medium leading-snug">{node.name}</div>
			<div className="mt-1 text-xs leading-relaxed text-muted-foreground">{node.statement}</div>
			{sourceIds.length > 0 ? (
				<div className="mt-3 flex flex-col gap-1">
					<div className="text-xs text-muted-foreground">Sessions</div>
					{sourceIds.map((sourceId) => {
						// An imported-notes file: a STATIC entry — the path, plain
						// text, never a link (no session to open).
						if (fileSources[sourceId] !== undefined) {
							return (
								<div key={sourceId} className="flex items-center gap-1.5">
									<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate px-2 py-1.5 text-sm text-muted-foreground">
										{fileSources[sourceId]}
									</span>
								</div>
							);
						}
						// A real session: deep-linkable provenance.
						return (
							<div key={sourceId} className="flex items-center gap-1.5">
								<Link
									href={propositionSessionHref(node, sourceId)}
									className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
								>
									{sessions[sourceId] ?? sourceId}
								</Link>
							</div>
						);
					})}
				</div>
			) : (
				<div className="mt-3 text-xs text-muted-foreground">No sessions recorded.</div>
			)}
		</div>
	);
}
