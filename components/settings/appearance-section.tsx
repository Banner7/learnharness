"use client";
/**
 * The Appearance + Graph sections (thin settings wave).
 *
 * Appearance controls resolve against the factory in the provider; writes
 * PUT the whole appearance section and apply reading typography immediately.
 *
 * Disabled dependent controls dim their entire row while preserving stored
 * values for when their parent setting is enabled again.
 *
 * The device theme is independent of server settings so each phone can
 * choose its own mode. Reading size and heading weight remain configurable.
 */

import { useEffect, useState } from "react";
import {
	EXTRACTION_CHUNK_TOKENS_FLOOR,
	resolveSettings,
	type AppearanceSettings,
	type GraphSettings,
} from "@/src/core";
import { useAppearance } from "./appearance.tsx";
import { CommitInput, SettingsRow, Toggle } from "./controls.tsx";
import { readThemeMode, saveThemeMode, type ThemeMode } from "@/lib/theme-mode";

export function AppearanceSection({
	appearance,
	onSectionChange,
}: {
	/** The record's appearance delta (absent = factory). */
	appearance: AppearanceSettings | undefined;
	/** PUT the whole appearance section; the page re-applies on success. */
	onSectionChange: (next: AppearanceSettings) => void;
}) {
	const { appearance: resolved } = useAppearance();
	const md = appearance?.mdRendering;
	const [themeMode, setThemeMode] = useState<ThemeMode>("system");
	useEffect(() => {
		// Redesign (owner, 2026-10-27): the pre-paint script owns the initial
		// mode; reading storage after mount only synchronizes the control.
		setThemeMode(readThemeMode());
	}, []);
	return (
		<>
			<SettingsRow label="Theme" testid="row-theme" stacked>
				<div role="radiogroup" aria-label="Theme" className="flex w-full rounded-md bg-muted p-1">
					{(["system", "light", "dark"] as const).map((mode) => (
						<button
							key={mode}
							type="button"
							role="radio"
							aria-checked={themeMode === mode}
							data-testid={`theme-${mode}`}
							onClick={() => {
								setThemeMode(mode);
								saveThemeMode(mode);
							}}
							className={`min-h-11 min-w-0 flex-1 rounded-md border px-2 text-sm font-medium ${
								themeMode === mode ? "border-border bg-card text-foreground" : "border-transparent text-muted-foreground"
							}`}
						>
							{mode === "system" ? "Automatic" : mode === "light" ? "Light" : "Dark"}
						</button>
					))}
				</div>
			</SettingsRow>
			<SettingsRow label="Reading font size" hint={`${resolved.proseFontSize}px`} testid="row-prose-size">
				<CommitInput
					type="number"
					value={String(appearance?.proseFontSize ?? "")}
					placeholder="17"
					ariaLabel="prose font size"
					testid="input-prose-size"
					onCommit={(v) => {
						// Empty = factory default (owner, fix wave): omit the key so the record
						// UNSETS and the field stays empty (absence, not null, is the
						// unset for numbers). Number("") is 0, so the old clamp wrote 12.
						if (v === "") {
							onSectionChange({ ...appearance, proseFontSize: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return; // bad input: no write, factory stays
						onSectionChange({ ...appearance, proseFontSize: Math.min(24, Math.max(12, Math.round(n))) });
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Heading weight" hint={`${resolved.mdRendering.headingWeight}`} testid="row-heading-weight">
				<CommitInput
					type="number"
					value={String(md?.headingWeight ?? "")}
					placeholder="700"
					ariaLabel="heading weight"
					testid="input-heading-weight"
					onCommit={(v) => {
						// Empty = factory default (owner, fix wave): Number("") is 0, so
						// Absence is the unset representation — the old clamp wrote 100.
						if (v === "") {
							onSectionChange({ ...appearance, mdRendering: { ...md, headingWeight: undefined } });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						onSectionChange({
							...appearance,
							mdRendering: { ...md, headingWeight: Math.min(900, Math.max(100, Math.round(n))) },
						});
					}}
				/>
			</SettingsRow>
		</>
	);
}

export function GraphSection({
	graph,
	onSectionChange,
}: {
	graph: GraphSettings | undefined;
	onSectionChange: (next: GraphSettings) => void;
}) {
	// Wave 7 collapse (owner ruling 2026-09-23): the section is the MASTER
	// SWITCH — the embedding/clustering/labeling rungs are gone; clustering
	// is the free birth-session partition derived on read, labels ARE session
	// names. The chunk budget (2026-10-02) joined it as the section's second
	// and only other control: it denominates the coverage ring AND gates the
	// auto-extraction trigger (turn settle ≥ budget fires the run).
	//
	// Resolved through the SAME core resolver the server's effective
	// settings use (one source of truth, the 4096-fallback fix 2026-10-02):
	// the hint and placeholder report exactly the number the trigger waits
	// for — never a second hand-rolled default.
	const resolved = resolveSettings(graph === undefined ? null : { version: 1, graph }).graph;
	return (
		<>
			{/* Extraction controls the pipeline and auditor; the chunk budget
			    below stays independent of this switch. */}
			<SettingsRow label="Extraction" hint="Off = the graph stops growing" testid="graph-row-enabled">
				<Toggle
					checked={graph?.enabled ?? true}
					label="extraction enabled"
					onChange={(on) =>
						// Compose, never replace-whole (the section PUT is, but the
					// row must not drop its sibling field — fixed with the budget
					// row's arrival: the old { enabled: on } wiped a stored budget).
						onSectionChange({ ...graph, enabled: on })
					}
				/>
			</SettingsRow>
			<SettingsRow
				label="Extraction chunk budget"
				hint={`${resolved.extractionChunkTokens} tok`}
				testid="graph-row-chunk-tokens"
			>
				<CommitInput
					type="number"
					value={String(graph?.extractionChunkTokens ?? "")}
					placeholder={String(resolved.extractionChunkTokens)}
					ariaLabel="extraction chunk budget"
					testid="input-chunk-tokens"
					onCommit={(v) => {
						// Empty = factory default (the fix-wave discipline): absence is
						// the unset for numbers — Number("") is 0, so clamping would
						// write the floor instead of unsetting.
						if (v === "") {
							onSectionChange({ ...graph, extractionChunkTokens: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n) || n <= 0) return; // bad input: no write
						// Mirror the server sanitize exactly: floor only (cost
						// protection), no ceiling — a big budget is the user's call.
						onSectionChange({
							...graph,
							extractionChunkTokens: Math.max(EXTRACTION_CHUNK_TOKENS_FLOOR, Math.round(n)),
						});
					}}
				/>
			</SettingsRow>
		</>
	);
}