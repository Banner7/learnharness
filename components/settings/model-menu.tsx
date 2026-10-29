"use client";
/**
 * Searchable model and font menus. Filtering ranks the visible
 * choices; tapping a row commits it.
 */

import { useEffect, useRef, useState } from "react";
import type { ModelCatalogEntry } from "@/src/core";
import { CLAUDE_CODE_PROVIDER, CUSTOM_PROVIDER, fuzzyScore } from "@/src/core";
import { formatTokens } from "@/components/usage-format";

function priceLabel(cost: ModelCatalogEntry["cost"]): string {
	if (!cost) return "Unpriced";
	const fmt = (n: number) => `$${n < 1 ? n.toFixed(2).replace(/0$/, "") : n.toFixed(2)}`;
	return `${fmt(cost.input)}/${fmt(cost.output)}`;
}

/** The model dropdown body — fuzzy search + ranked list. `models ===
 *  undefined` is the catalog-loading state; an empty result list gets
 *  its own quiet line. */
export function ModelMenuList({
	models,
	effectiveId,
	effectiveProvider,
	onPick,
	footer,
	vision,
}: {
	/** The full catalog — undefined while it loads. */
	models: ModelCatalogEntry[] | undefined;
	/** Currently effective id (the row gets the quiet highlight). */
	effectiveId: string | undefined;
	/** The effective id's provider (model-slots wave: the catalog
	 *  federates multiple providers and ids can collide across them —
	 *  the highlight must match BOTH coordinates or it lands on the
	 *  wrong row). */
	effectiveProvider?: string;
	/** Receives the chosen entry. */
	onPick: (entry: ModelCatalogEntry) => void;
	/** Quiet footer note under the list (context-specific). */
	footer?: string;
	/** Vision slot: only image-capable models are selectable — plus every
	 *  custom-endpoint model, whose capability the endpoint may not report.
	 *  Image-capable ones float to the top. */
	vision?: boolean;
}) {
	const [query, setQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		searchRef.current?.focus();
	}, []);


	// The filtered, ranked model list.
	const results = (models ?? [])
		// Fork (2026-10-29): server-configured endpoints may accept images without advertising that capability.
		.filter((m) => !vision || m.input.includes("image") || m.provider === CUSTOM_PROVIDER.id || m.serverManaged)
		.map((m) => ({ m, s: fuzzyScore(query, m.provider, m.id, m.name) }))
		.filter((r) => r.s !== null)
		.sort((a, b) => (vision ? Number(b.m.input.includes("image")) - Number(a.m.input.includes("image")) : 0) || b.s! - a.s! || a.m.id.localeCompare(b.m.id))
		.map((r) => r.m);

	return (
		<>
			<input
				ref={searchRef}
				data-testid="model-search"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="Search models…"
				className="lh-input mb-2 min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
			/>
			{!models && <div className="px-2 py-3 text-center text-muted-foreground">Loading models…</div>}
			{models && results.length === 0 && (
				<div className="px-2 py-3 text-center text-muted-foreground">No models match.</div>
			)}
			<ul data-testid="model-list" className="flex max-h-72 flex-col overflow-y-auto px-1">
				{results.map((m) => (
					<li key={`${m.provider}/${m.id}`}>
						<button
							type="button"
							data-testid={`model-option-${m.id.replace(/[^a-z0-9-]/gi, "_")}`}
							onClick={() => onPick(m)}
							className={`flex min-h-11 w-full flex-col justify-center gap-0.5 rounded-md px-3 py-1 text-left outline-none hover:bg-muted${m.id === effectiveId && m.provider === (effectiveProvider ?? m.provider) ? " bg-muted" : ""}`}
						>
							<span className="flex items-center justify-between gap-2">
								<span className="truncate text-card-foreground">{m.name}</span>
								<span className="shrink-0 tabular-nums text-muted-foreground" title={m.provider === CLAUDE_CODE_PROVIDER ? "Billing is determined by your Claude Code configuration; LearnHarness does not estimate it." : m.cost ? "USD per 1M tokens in/out" : "Price unavailable"}>
									{m.provider === CLAUDE_CODE_PROVIDER ? "CLI billing" : priceLabel(m.cost)}
								</span>
							</span>
							<span className="flex items-center justify-between gap-2 text-muted-foreground">
								<span className="truncate">{m.provider} {m.id}</span>
								<span className="shrink-0 tabular-nums">{m.contextWindow === null ? "—" : formatTokens(m.contextWindow)}</span>
							</span>
						</button>
					</li>
				))}
			</ul>
			{footer && (
				<div className="mt-1 border-t border-border px-2 pt-2 text-xs text-muted-foreground">{footer}</div>
			)}
		</>
	);
}

/** The thinking-level dropdown body — the levels this model actually
 *  supports, ✓ on the effective one. Same shape as the chat selector's. */
export function ThinkingMenuList({
	levels,
	effectiveLevel,
	onPick,
	empty,
	footer,
}: {
	levels: string[];
	effectiveLevel: string | undefined;
	onPick: (level: string) => void;
	/** Shown instead of the list when there are no levels. */
	empty?: string;
	footer?: string;
}) {
	return (
		<>
			{levels.length === 0 ? (
				<div className="px-2 py-3 text-center text-muted-foreground">{empty ?? "No thinking levels."}</div>
			) : (
				levels.map((level) => (
					<button
						key={level}
						type="button"
						data-testid={`thinking-option-${level}`}
						onClick={() => onPick(level)}
						className={`flex min-h-11 items-center justify-between rounded-md px-3 text-left hover:bg-muted ${
							level === effectiveLevel ? "bg-muted text-card-foreground" : "text-card-foreground"
						}`}
					>
						<span>{level}</span>
						{level === effectiveLevel && <span aria-hidden>✓</span>}
					</button>
				))
			)}
			{footer && (
				<div className="mt-1 border-t border-border px-2 pt-2 text-xs text-muted-foreground">{footer}</div>
			)}
		</>
	);
}

/** The reading-font dropdown's default row (null) matches the factory
 * Computer Modern family or \"default\" queries, appearing only among matching
 * search results. Pure — exported for tests. */
export function fontMenuResults(query: string, families: string[]): Array<string | null> {
	const scored = families
		.map((f) => ({ f, s: fuzzyScore(query, f) }))
		.filter((r) => r.s !== null)
		.sort((a, b) => b.s! - a.s! || a.f.localeCompare(b.f))
		.map((r) => r.f);
	// The default row's searchable identity: the factory family + the
	// word "default" (the suffix it renders with).
	const defaultScore = fuzzyScore(query, "Computer Modern Serif", "default");
	if (query.trim() === "" || defaultScore !== null) return [null, ...scored];
	return scored;
}

/** The custom-family action row's decision (pure, 2026-09-26): a typed
 *  query that matches NO family becomes the "Use '<query>'" custom pick —
 *  a matching family is the better pick, so the action row only exists
 *  when there is nothing else to pick. Exported for tests. */
export function customFamilyFor(query: string, families: string[]): string | null {
	const trimmed = query.trim();
	if (trimmed === "") return null;
	return fontMenuResults(query, families).length === 0 ? trimmed : null;
}

/** The reading-font dropdown body — ONE search field (owner ask
 *  2026-09-26: "why two?"): the fuzzy machine filters the families, and
 *  when nothing matches, a "Use '<query>'" action row commits the typed
 *  text as a custom family — the old separate custom input is gone, the
 *  search field absorbed its job. `families === undefined` is the
 *  enumerating state; the curated fallback arrives as plain families with
 *  a footer that says so honestly. */
export function FontMenuList({
	families,
	effectiveFamily,
	onPick,
	footer,
}: {
	/** Enumerated font families (already deduped/sorted by the caller);
	 *  undefined while the enumeration runs. */
	families: string[] | undefined;
	/** The stored override (null = factory Computer Modern Serif). */
	effectiveFamily: string | null;
	/** Receives the pick: a family string, or null for the default. */
	onPick: (family: string | null) => void;
	/** Quiet footer note under the list. */
	footer?: string;
}) {
	const [query, setQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		searchRef.current?.focus();
	}, []);


	const results = fontMenuResults(query, families ?? []);
	// Offer custom family only when the typed query matches no family.
	const customFamily = customFamilyFor(query, families ?? []);

	return (
		<>
			<input
				ref={searchRef}
				data-testid="font-search"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="Search fonts…"
				className="lh-input mb-2 min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
			/>
			{!families && <div className="px-2 py-3 text-center text-muted-foreground">Loading fonts…</div>}
			<ul data-testid="font-list" className="flex max-h-72 flex-col overflow-y-auto px-1">
				{families &&
					results.map((family) => {
						const isDefault = family === null;
						const effective = isDefault ? effectiveFamily === null : family === effectiveFamily;
						return (
							<li key={family ?? "__default"}>
								<button
									type="button"
									data-testid={isDefault ? "font-option-default" : `font-option-${family.replace(/[^a-z0-9-]/gi, "_")}`}
									onClick={() => onPick(family)}
									className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 text-left outline-none hover:bg-muted${effective ? " bg-muted" : ""}`}
								>
									<span className="truncate text-card-foreground">{family ?? "Computer Modern Serif"}</span>
									<span className="shrink-0 text-muted-foreground">{isDefault ? "Default" : effective && <span aria-hidden>✓</span>}</span>
								</button>
							</li>
						);
					})}
				{families && customFamily !== null && (
					<li>
						<button
							type="button"
							data-testid="font-option-custom"
							onClick={() => onPick(customFamily)}
							className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 text-left outline-none hover:bg-muted"
						>
							<span className="truncate text-card-foreground">Use “{customFamily}”</span>
							<span className="shrink-0 text-muted-foreground">Custom</span>
						</button>
					</li>
				)}
			</ul>
			{footer && <div className="px-2 pt-1.5 text-xs text-muted-foreground">{footer}</div>}
		</>
	);
}
