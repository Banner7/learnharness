"use client";

/**
 * The vault library's surfaces (fork, owner-approved design 2026-11-01):
 * a one-line bar in the chain table ("Vault · 16 notes · 3 waiting
 * [Sync now]") and the Settings → Library section (auto-extract switch,
 * skip list, the one-off PDF upload). Everything renders nothing when the
 * server has no LH_VAULT_DIR, so upstream behavior is untouched.
 */
import { useCallback, useEffect, useState } from "react";
import type { LibrarySettings } from "@/src/core";
import { useServerEvent } from "./server-events";
import { SettingsRow, Toggle } from "./settings/controls.tsx";
import { NotesImportControl, NotesImportErrors, NotesImportNotices, useNotesImport } from "./notes-import.tsx";

export interface LibraryStatus {
	enabled: boolean;
	autoExtract: boolean;
	exclude: string[];
	notes: number;
	waiting: number;
	missing: number;
	skipped: number;
	extracting: string | null;
	draining: boolean;
	/** Why the last drain stopped on a setup refusal, else null. */
	blocked: string | null;
}

export function useLibrary(): { status: LibraryStatus | null; syncNow: () => Promise<void>; error: string | null } {
	const [status, setStatus] = useState<LibraryStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refresh = useCallback(async () => {
		const response = await fetch("/api/library", { cache: "no-store" }).catch(() => null);
		if (response?.ok) setStatus(await response.json() as LibraryStatus);
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);
	useServerEvent("sources-changed", () => { void refresh(); });
	const syncNow = useCallback(async () => {
		setError(null);
		const response = await fetch("/api/library", { method: "POST" }).catch(() => null);
		const body = await response?.json().catch(() => null) as (LibraryStatus & { error?: string }) | null;
		if (!response?.ok) setError(body?.error ?? "Could not start the sync.");
		else if (body) setStatus(body);
	}, []);
	return { status, syncNow, error };
}

/** The chain table's library line. Sync now is disabled while a drain runs
 * (the server absorbs a second request anyway; the button says so). When
 * notes are missing, a Review button toggles the missing-only filter in the
 * overlay that owns it (owner, 2026-11-01). */
export function LibraryBar({ reviewing = false, onReview }: { reviewing?: boolean; onReview?: () => void }) {
	const { status, syncNow, error } = useLibrary();
	if (!status?.enabled) return null;
	const busy = status.draining || status.extracting !== null;
	const parts = [`${status.notes} ${status.notes === 1 ? "note" : "notes"}`];
	if (status.waiting) parts.push(`${status.waiting} waiting`);
	if (status.missing) parts.push(`${status.missing} missing`);
	if (status.skipped) parts.push(`${status.skipped} skipped`);
	return (
		<div data-testid="library-bar" className="flex items-center gap-3 border-b border-border px-4 py-2 font-ui text-sm">
			<span className="min-w-0 flex-1 truncate text-muted-foreground">
				<span className="text-foreground">Vault</span> · {parts.join(" · ")}
				{error && <span role="alert" className="ml-2 text-wrong">{error}</span>}
				{status.blocked && <span className="ml-2 text-wrong">Sync stopped: {status.blocked}</span>}
			</span>
			{status.missing > 0 && onReview && (
				<button type="button" data-testid="library-review" onClick={onReview}
					className="shrink-0 rounded-md border border-border bg-card px-3 py-1 text-sm transition-colors hover:bg-accent">
					{reviewing ? "Show all" : "Review"}
				</button>
			)}
			<button type="button" data-testid="library-sync" disabled={busy || status.waiting === 0}
				onClick={() => void syncNow()}
				className="shrink-0 rounded-md border border-border bg-card px-3 py-1 text-sm transition-colors hover:bg-accent disabled:opacity-50 disabled:hover:bg-card">
				{busy ? "Syncing…" : "Sync now"}
			</button>
		</div>
	);
}

/** Settings → Library. The skip list commits on blur (each commit is a
 * section PUT and a rescan), one pattern per line. */
export function LibrarySection({ library, onSectionChange }: {
	library: LibrarySettings | undefined;
	onSectionChange: (next: LibrarySettings) => void;
}) {
	const { status } = useLibrary();
	const exclude = library?.exclude ?? status?.exclude ?? [];
	const [draft, setDraft] = useState(exclude.join("\n"));
	const saved = exclude.join("\n");
	useEffect(() => { setDraft(saved); }, [saved]);
	const { errors, notices, importing, onImportFiles } = useNotesImport();
	if (status && !status.enabled) {
		return <p className="px-6 py-5 text-sm text-muted-foreground">No vault folder is configured on the server (LH_VAULT_DIR).</p>;
	}
	return (
		<>
			<SettingsRow label="Auto-extract" hint="After 5 quiet minutes on a note" testid="library-row-auto">
				<Toggle checked={library?.autoExtract ?? false} label="auto-extract vault notes"
					onChange={(on) => onSectionChange({ ...library, exclude, autoExtract: on })} />
			</SettingsRow>
			<SettingsRow label="Skip" hint="One per line: folder/, exact/path.md, or a glob (* in a folder, ** across folders)" testid="library-row-skip" stacked>
				<textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} aria-label="vault paths to skip"
					data-testid="library-skip"
					onBlur={() => {
						const next = draft.split("\n").map((line) => line.trim()).filter(Boolean);
						if (next.join("\n") !== saved) onSectionChange({ ...library, exclude: next });
					}}
					className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary" />
				{/* The live effect of the list (owner, 2026-11-01): followed notes it now skips. */}
				{status && <p className="mt-1.5 text-xs text-muted-foreground" data-testid="library-skip-count">
					{status.skipped} {status.skipped === 1 ? "note" : "notes"} skipped
				</p>}
			</SettingsRow>
			<SettingsRow label="Upload a PDF" hint="One-off files outside the vault" testid="library-row-upload">
				<NotesImportControl importing={importing} onImportFiles={onImportFiles} />
			</SettingsRow>
			<NotesImportNotices notices={notices} />
			<NotesImportErrors errors={errors} />
		</>
	);
}
