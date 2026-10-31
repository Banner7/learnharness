"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeftIcon } from "lucide-react";
import type { ModelCatalogEntry, ModelSlotName, ModelsSettings, UserSettings } from "@/src/core";
import { prettyModel } from "@/components/usage-format";
import { ModelMenuList, ThinkingMenuList } from "@/components/settings/model-menu";
import { composeSlotModel } from "@/components/settings/agent-section";
import { Hint } from "@/components/ui/hint";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { defaultOrderLevel, populateLevel, THINKING_LABEL } from "@/components/thinking-default";
import { readSettingsRecord } from "@/components/settings-record";
import { useModelCatalog } from "@/components/model-picker";

/**
 * The helpers switcher (owner, 2026-10-31): the cheap and vision slots were
 * reachable only from Settings → Agent, yet they decide what every research,
 * demo, grading, drawing and PDF job runs on. One quiet "Helpers" chip sits
 * beside the strong-slot pickers; its menu edits the same GLOBAL slots
 * through the same seam Settings uses (PUT /api/settings/models with
 * composeSlotModel, siblings preserved), then announces the write so the
 * Settings section and every other reader re-read. One inline panel with
 * three views (summary → a slot's model list or thinking list) serves
 * phone and desktop alike.
 */

type HelperSlot = Extract<ModelSlotName, "cheap" | "vision">;
type View = { kind: "summary" } | { kind: "model" | "thinking"; slot: HelperSlot };

const HELPERS: readonly { slot: HelperSlot; label: string; hint: string }[] = [
	{ slot: "cheap", label: "Cheap", hint: "Research, demos, grading" },
	{ slot: "vision", label: "Vision", hint: "Drawings and PDFs" },
];

export function HelpersControl() {
	const { catalog, refresh } = useModelCatalog();
	const [models, setModels] = useState<ModelsSettings | undefined>();
	const [view, setView] = useState<View | null>(null);
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const readRecord = useCallback(() => {
		readSettingsRecord()
			.then((body) => setModels(body.settings?.models ?? undefined))
			.catch(() => {
				/* read-only posture: triggers show "—", same as ModelControl */
			});
	}, []);
	useEffect(() => readRecord(), [readRecord]);
	useSettingsSaved((section) => {
		if (section === "models") readRecord();
	});

	// Escape steps back out of a list first, then collapses the panel.
	useEffect(() => {
		if (view === null) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setView((v) => (v && v.kind !== "summary" ? { kind: "summary" } : null));
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [view]);

	const save = useCallback(async (next: ModelsSettings) => {
		setError(null);
		try {
			const res = await fetch("/api/settings/models", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(next),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? `settings rejected (${res.status})`);
				return;
			}
			// Server truth: a level the new model can't run lands clamped.
			const stored = ((await res.json().catch(() => null)) as { settings?: UserSettings } | null)?.settings?.models;
			setModels(stored ?? next);
			setView({ kind: "summary" });
			notifySettingsSaved("models");
		} catch {
			setError("Could not reach the server — try again.");
		}
	}, []);

	const slotState = (slot: HelperSlot) => {
		const stored = models?.[slot];
		const entry = catalog?.models.find((m) => m.id === stored?.model?.id && m.provider === stored?.model?.provider);
		const levels = entry?.supportedLevels ?? [];
		// Legacy display, as in Settings: no stored level shows the level the
		// engine would resolve; display-only until a pick writes one.
		const level = stored?.thinkingLevel ?? (entry ? defaultOrderLevel(levels) : undefined);
		const modelLabel = stored?.model ? (entry?.label ?? prettyModel(stored.model.id)) : undefined;
		return { stored, entry, levels, level, modelLabel };
	};

	const toggle = () => {
		setError(null);
		setView((v) => (v ? null : { kind: "summary" }));
	};

	const trigger = "flex min-h-11 min-w-0 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-accent hover:text-foreground";

	return (
		<div ref={containerRef} className={`flex flex-col items-start ${view ? "w-full" : ""}`} data-testid="helpers-control">
			<Hint label="Models for research, demos, grading, drawings and PDFs" side="bottom">
				<button
					type="button"
					data-testid="helpers-chip"
					onClick={toggle}
					aria-expanded={view !== null}
					aria-haspopup="dialog"
					className="group flex min-h-11 items-center text-xs"
				>
					{/* Filled pill (owner, 2026-10-31): sets Helpers apart from the bare
					    strong-slot pickers; the 44px hit area stays on the button. */}
					<span className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 transition-colors group-hover:bg-accent">
						<span className="text-foreground">Helpers</span>
						<span aria-hidden className={`text-muted-foreground transition-transform ${view ? "rotate-180" : ""}`}>▾</span>
					</span>
				</button>
			</Hint>

			{/* Inline dropdown (owner, 2026-10-31): the panel expands in place
			    under the chip and pushes what follows down, instead of an
			    anchored overlay card covering the composer or the rail. */}
			{view && (
				<div
					data-testid="helpers-menu"
					className="mt-1 flex max-h-[min(24rem,60dvh)] w-[22rem] max-w-full flex-col overflow-y-auto rounded-lg border border-border bg-card p-2 text-xs"
				>
					{view.kind === "summary" ? (
						<div role="dialog" aria-label="Helper models" className="flex flex-col gap-1">
							{HELPERS.map(({ slot, label, hint }) => {
								const { entry, level, modelLabel } = slotState(slot);
								return (
									<div key={slot} className="flex items-center gap-2 rounded-md px-1 py-1" data-testid={`helpers-row-${slot}`}>
										<div className="min-w-0 flex-1">
											<div className="text-sm text-foreground">{label}</div>
											<div className="text-muted-foreground">{hint}</div>
										</div>
										<button
											type="button"
											data-testid={`helpers-model-${slot}`}
											aria-label={`${label} model`}
											onClick={() => { refresh(); setView({ kind: "model", slot }); }}
											className={`${trigger} w-[6.5rem] shrink-0 justify-end`}
										>
											<span className="truncate text-foreground">{modelLabel ?? "—"}</span>
											<span aria-hidden className="text-muted-foreground">▾</span>
										</button>
										<button
											type="button"
											data-testid={`helpers-thinking-${slot}`}
											aria-label={`${label} thinking`}
											// No model → nothing to set a level for (ModelControl's rule).
											onClick={() => { if (entry) setView({ kind: "thinking", slot }); }}
											className={`${trigger} w-[5rem] shrink-0 justify-end`}
										>
											<span className="text-foreground">{level === undefined ? "—" : (THINKING_LABEL[level] ?? level)}</span>
											<span aria-hidden className="text-muted-foreground">▾</span>
										</button>
									</div>
								);
							})}
							<div className="px-1 pt-1 text-muted-foreground">Applies to every session; same as Settings → Agent.</div>
						</div>
					) : (
						<div className="flex flex-col">
							<button
								type="button"
								onClick={() => setView({ kind: "summary" })}
								className="mb-1 flex min-h-9 items-center gap-1 self-start rounded-md px-1 text-muted-foreground hover:text-foreground"
							>
								<ChevronLeftIcon className="size-3.5" aria-hidden />
								{HELPERS.find((h) => h.slot === view.slot)?.label} {view.kind === "model" ? "model" : "thinking"}
							</button>
							{view.kind === "model" ? (
								<ModelMenuList
									models={catalog?.models}
									effectiveId={slotState(view.slot).stored?.model?.id}
									effectiveProvider={slotState(view.slot).stored?.model?.provider}
									vision={view.slot === "vision"}
									onPick={(m: ModelCatalogEntry) => {
										const next = populateLevel(slotState(view.slot).stored?.thinkingLevel, m.supportedLevels);
										void save(composeSlotModel(models, view.slot, m.provider, m.id, next));
									}}
									footer={catalog && catalog.models.length === 0 ? "No models — configure a provider on the server" : "Runs every agent of this tier"}
								/>
							) : (
								<ThinkingMenuList
									levels={slotState(view.slot).levels.map(String)}
									effectiveLevel={slotState(view.slot).level}
									onPick={(level) => {
										const { stored } = slotState(view.slot);
										void save(composeSlotModel(models, view.slot, stored?.model?.provider ?? "", stored?.model?.id ?? "", level));
									}}
									empty={catalog ? "This model has no thinking levels." : "Loading…"}
									footer="Levels this model actually supports"
								/>
							)}
						</div>
					)}
					{error && <div className="mt-1.5 text-destructive">{error}</div>}
				</div>
			)}
		</div>
	);
}
