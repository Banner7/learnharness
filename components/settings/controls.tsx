"use client";
/**
 * Thin settings primitives (settings-app wave): the control kit the
 * settings dialog needs. Sections → groups → rows; everything SSRs clean
 * (render tests pin the sections' markup).
 *
 * A disabled dependent control dims its whole row (label and input).
 */

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A section's content; the dialog owns its visible page heading. */
export function SettingsSection({
	title,
	hint,
	children,
	testid,
}: {
	title: string;
	/** One quiet line under the header — only where it earns its place. */
	hint?: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<section aria-label={title} data-testid={testid} className="@container min-w-0 px-4 py-5 font-ui">
			{hint && <p className="mb-4 text-xs text-muted-foreground">{hint}</p>}
			<div className="flex min-w-0 flex-col gap-3">{children}</div>
		</section>
	);
}

/** A labeled sub-group inside a section (owner, 2026-09-20: clear
 *  separation — Models / Tools / Prompts read as three blocks). */
export function SettingsGroup({
	label,
	hint,
	children,
	testid,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<div data-testid={testid} className="mt-5 border-t border-border pt-4 first:mt-0 first:border-t-0 first:pt-0">
			<p className="mb-2 text-sm font-semibold text-foreground">{label}</p>
			{hint && <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
			<div className="flex min-w-0 flex-col gap-2">{children}</div>
		</div>
	);
}

/** Label and control stack in each settings row. */
export function SettingsRow({
	label,
	hint,
	children,
	testid,
	dimmed,
	stacked,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
	testid?: string;
	/** Dim the whole row while its dependent control is unavailable. */
	dimmed?: boolean;
	/** Segmented choices need the full row width at phone size. */
	stacked?: boolean;
}) {
	return (
		<div data-testid={testid} className={cn("flex min-h-11 min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-2", stacked && "flex-col items-stretch", dimmed && "opacity-40")}>
			<span className="min-w-32 flex-1">
				<span className="block text-sm font-medium">{label}</span>
				{hint && <span className="block text-xs leading-relaxed text-muted-foreground">{hint}</span>}
			</span>
			<div className={cn("flex min-w-0 max-w-full items-center justify-end gap-2 text-right", stacked && "w-full")}>{children}</div>
		</div>
	);
}

/** A provider's name and status with one optional trailing action. */
export function StatusRow({
	label,
	status,
	hint,
	action,
	testid,
}: {
	label: string;
	status: ReactNode;
	hint?: string;
	action?: ReactNode;
	testid?: string;
}) {
	return (
		<div data-testid={testid} className="flex min-h-11 min-w-0 items-center gap-3 py-2">
			<div className="min-w-0 flex-1">
				<span className="block truncate text-sm font-medium">{label}</span>
				{hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
			</div>
			<span className="min-w-0 shrink truncate text-right text-xs text-muted-foreground">{status}</span>
			{action && <div className="flex shrink-0 items-center justify-end">{action}</div>}
		</div>
	);
}

/** The on/off switch — a plain button in the switch role. */
export function Toggle({
	checked,
	disabled,
	onChange,
	label,
	discIcon,
	title,
}: {
	checked: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
	/** Accessible name for the switch role. */
	label: string;
	/** Optional icon disc (owner round, 2026-10-07): the figure cards' invert
	 *  toggle renders the half-filled contrast circle AS the disc — the icon
	 *  carries the meaning; plain toggles keep the plain disc. */
	discIcon?: ReactNode;
	/** Optional native tooltip on the switch. */
	title?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			{...(title ? { title } : {})}
			disabled={disabled}
			data-testid={`toggle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
			onClick={() => onChange(!checked)}
			className={cn("relative min-h-11 min-w-11 shrink-0 rounded-md", disabled && "cursor-not-allowed")}
		>
			<span aria-hidden className={cn(
				"absolute left-1.5 top-3 h-4.5 w-8 rounded-full border border-border",
				checked ? "bg-primary" : "bg-muted",
			)} />
			{discIcon ? (
				// The icon IS the disc: same size, same slide, same state colors —
				// only the knob's face changes (the invert affordance).
				<span
					className={cn(
						"absolute left-1.5 top-3.5 flex size-3 items-center justify-center rounded-full transition-transform",
						checked ? "translate-x-4 text-primary-foreground" : "translate-x-0.5 text-muted-foreground",
					)}
				>
					{discIcon}
				</span>
			) : (
				<span
					className={cn(
						"absolute left-1.5 top-3.5 size-3 rounded-full transition-transform",
						checked ? "translate-x-4 bg-primary-foreground" : "translate-x-0.5 bg-muted-foreground",
					)}
				/>
			)}
		</button>
	);
}

/** A thin select — native element, options as given. */
function ThinSelect({
	value,
	onChange,
	children,
	ariaLabel,
	testid,
	disabled,
}: {
	value: string;
	onChange: (next: string) => void;
	children: React.ReactNode;
	ariaLabel: string;
	testid?: string;
	disabled?: boolean;
}) {
	return (
		<select
			value={value}
			aria-label={ariaLabel}
			data-testid={testid}
			disabled={disabled}
			onChange={(e) => onChange(e.target.value)}
			className={cn(
				"min-h-11 min-w-0 w-full truncate rounded-md border border-border bg-background px-3 text-right text-sm text-foreground outline-none",
				disabled && "cursor-not-allowed",
			)}
		>
			{children}
		</select>
	);
}

/** A thin hex/text input committing on blur + Enter (settings pace, not
 *  typing pace — every commit is a section PUT). */
export function CommitInput({
	value,
	placeholder,
	onCommit,
	ariaLabel,
	testid,
	type = "text",
}: {
	/** "" = unset (the factory default). Mirrors the STORED record —
	 *  after a clamped/normalized commit this flows back and the field
	 *  snaps to the stored truth (owner repro: a negative size kept
	 *  displaying "-5" while 12 was stored). */
	value: string;
	placeholder?: string;
	onCommit: (next: string) => void;
	ariaLabel: string;
	testid?: string;
	type?: "text" | "number";
}) {
	// The draft exists only while editing; a blur shows the record's value
	// again — commit-on-blur/Enter (owner ruling), the field honest about
	// what landed.
	const [draft, setDraft] = useState(value);
	const [editing, setEditing] = useState(false);
	return (
		<input
			type={type}
			value={editing ? draft : value}
			placeholder={placeholder}
			aria-label={ariaLabel}
			data-testid={testid}
			onChange={(e) => {
				setEditing(true);
				setDraft(e.target.value);
			}}
			onBlur={() => {
				if (!editing) return;
				setEditing(false);
				const next = draft.trim();
				if (next !== value) onCommit(next);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
			}}
			className="lh-input font-ui tabular-nums min-h-11 min-w-0 w-full rounded-md border border-border bg-background px-3 text-right text-sm text-foreground outline-none placeholder:text-muted-foreground"
		/>
	);
}