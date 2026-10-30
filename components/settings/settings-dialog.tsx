"use client";
/**
 * Phone settings sheet: the section list opens first, then one section at a
 * time. Deep links open their section directly. The dialog shares one settings
 * record and write seam across sections, so navigation never refetches.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import {
	CURRENT_SETTINGS_VERSION,
	type AgentSettings,
	type AppearanceSettings,
	type CompactionSettings,
	type GraphSettings,
	type UserSettings,
} from "@/src/core";
import { useAppearance } from "./appearance.tsx";
import { SettingsSection } from "./controls.tsx";
import { AgentSection } from "./agent-section.tsx";
import type { ModelsSettings } from "@/src/core";
import { MENU_CLOSE_EVENT, MENU_OPEN_EVENT } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";
import { ProvidersSection } from "./keys-section.tsx";
import { AppearanceSection, GraphSection } from "./appearance-section.tsx";

const SECTIONS = [
	{ id: "keys", label: "Providers" },
	{ id: "agent", label: "Models" },
	{ id: "appearance", label: "Appearance" },
	{ id: "graph", label: "Graph" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

/** `open(section?)` lands the dialog on a specific section. */
const DialogContext = createContext<{ open: (section?: string) => void }>({ open: () => {} });

/** AppShell-level mount. Deep links open a section directly; bare opens
 * show the section list. */
export function SettingsDialogProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [show, setShow] = useState(false);
	const [landOn, setLandOn] = useState<SectionId>("keys");
	/** Bare opens show the list; deep links land on their section. */
	const [landLevel, setLandLevel] = useState<"list" | "section">("section");
	const [openRequest, setOpenRequest] = useState(0);
	const open = useCallback((section?: string) => {
		setLandOn(section ? section as SectionId : "keys");
		setLandLevel(section ? "section" : "list");
		setOpenRequest((request) => request + 1);
		setShow(true);
	}, []);
	return (
		<DialogContext.Provider value={{ open }}>
			{children}
			{show && (
				<SettingsDialog onClose={() => setShow(false)} initialSection={landOn} initialLevel={landLevel} openRequest={openRequest} />
			)}
		</DialogContext.Provider>
	);
}

export function useSettingsDialog() {
	return useContext(DialogContext);
}

function SettingsDialog({
	onClose,
	initialSection,
	initialLevel,
	openRequest,
}: {
	onClose: () => void;
	initialSection: SectionId;
	initialLevel: "list" | "section";
	openRequest: number;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	// Plain dim backdrop (no blur — nothing decorative); a genuine
	// backdrop click closes, the dialog body stops propagation.
	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-background/80"
			data-testid="settings-backdrop"
			{...backdropDismiss}
		>
			<SettingsDialogBody onClose={onClose} initialSection={initialSection} initialLevel={initialLevel} openRequest={openRequest} />
		</div>,
		document.body,
	);
}

/** The dialog without the portal/backdrop — the SSR-testable frame
 *  (portals render nothing under renderToStaticMarkup). */
function SettingsDialogBody({
	onClose,
	initialSection = "keys",
	initialLevel = "section",
	openRequest = 0,
}: {
	onClose: () => void;
	initialSection?: SectionId;
	/** Initial navigation level for a bare open or a section deep link. */
	initialLevel?: "list" | "section";
	openRequest?: number;
}) {
	const { onAppearanceChange } = useAppearance();
	const [record, setRecord] = useState<UserSettings | null | undefined>(
		undefined,
	);
	const [error, setError] = useState<string | null>(null);
	// MenuShell open-count — drives the content column's scroll lock.
	const [openMenus, setOpenMenus] = useState(0);
	const contentRef = useRef<HTMLDivElement | null>(null);
	// Scroll-lock (fix wave, owner ruling: the scrollbar MAY stay,
	// scrolling must NOT happen, nothing may move): the content column
	// keeps overflow-y-auto — the scrollbar and every width stay exactly
	// as they are — and while any MenuShell is open, non-passive wheel +
	// touchmove listeners on the column preventDefault. React attaches
	// synthetic wheel/touch passively at the root, so this needs the
	// native-listener ref seam.
	useEffect(() => {
		const el = contentRef.current;
		if (!el || openMenus === 0) return;
		const block = (e: Event) => e.preventDefault();
		el.addEventListener("wheel", block, { passive: false });
		el.addEventListener("touchmove", block, { passive: false });
		return () => {
			el.removeEventListener("wheel", block);
			el.removeEventListener("touchmove", block);
		};
	}, [openMenus]);

	useEffect(() => {
		const onOpen = () => setOpenMenus((n) => n + 1);
		const onClose = () => setOpenMenus((n) => Math.max(0, n - 1));
		window.addEventListener(MENU_OPEN_EVENT, onOpen);
		window.addEventListener(MENU_CLOSE_EVENT, onClose);
		return () => {
			window.removeEventListener(MENU_OPEN_EVENT, onOpen);
			window.removeEventListener(MENU_CLOSE_EVENT, onClose);
		};
	}, []);
	const [active, setActive] = useState<SectionId>(initialSection);
	const [phoneLevel, setPhoneLevel] = useState(initialLevel);
	// A section link fired while the dialog is already open changes
	// initialSection under our feet — follow it or the link does nothing.
	useEffect(() => {
		setActive(initialSection);
		setPhoneLevel(initialLevel);
	}, [initialSection, initialLevel, openRequest]);

	// Fetch once per dialog mount. 200 {settings: null} is FIRST BOOT
	// (no record = factory everything), not a failure — the error state is
	// a non-200 or a network throw only.
	useEffect(() => {
		fetch("/api/settings")
			.then((r) =>
				r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)),
			)
			.then((body: { settings: UserSettings | null }) =>
				setRecord(body.settings ?? { version: CURRENT_SETTINGS_VERSION }),
			)
			.catch(() => setRecord(null));
	}, []);


	/** ONE writer for the whole dialog: PUT the whole section, keep the
	 *  record mirror in sync, surface route errors inline (a 400 is a
	 *  schema mistake caught by the validation surface). */
	const write = useCallback(
		async (
			section: "agent" | "models" | "appearance" | "graph" | "compaction",
			body: object,
		) => {
			setError(null);
			const res = await fetch(`/api/settings/${section}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				setError(`${section}: ${detail.error ?? res.status}`);
				return;
			}
			// Server truth, never the request body (fix wave, owner repro):
			// the models section clamps pinned thinking levels on write
			// (bd68486) — a swap that rides an unsupported level lands
			// CLAMPED in the record, and the writing surface must show the
			// stored value in this same interaction, not the optimistic one.
			const stored = (
				(await res.json().catch(() => null)) as { settings?: UserSettings } | null
			)?.settings;
			setRecord(
				(prev) =>
					stored ?? ({ ...(prev ?? {}), [section]: body }) as UserSettings,
			);
			notifySettingsSaved(section);
			if (section === "appearance")
				onAppearanceChange(body as AppearanceSettings);
		},
		[onAppearanceChange],
	);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Settings"
			data-testid="settings-dialog"
			className="settings-dialog-pop flex h-dvh max-h-dvh w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card font-ui"
			onClick={(e) => e.stopPropagation()}
		>
			{/* Header — the app's quiet CMU title language. */}
			<header className="flex h-15 shrink-0 items-center gap-3 border-b border-border px-5">
				{phoneLevel === "section" && (
					<button
						type="button"
						data-testid="settings-back"
						className="min-h-11 shrink-0 rounded-md px-2 text-sm text-muted-foreground hover:text-foreground"
						onClick={() => setPhoneLevel("list")}
					>
						‹ Settings
					</button>
				)}
				<h2 className="min-w-0 flex-1 font-title text-2xl tracking-tight">
					{phoneLevel === "list" ? "Settings" : SECTIONS.find((s) => s.id === active)?.label}
				</h2>
				<button
					type="button"
					aria-label="Close settings"
					data-testid="settings-close"
					className="ml-auto flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
					onClick={onClose}
				>
					<svg
						viewBox="0 0 16 16"
						className="size-4"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<path d="M4 4l8 8M12 4l-8 8" />
					</svg>
				</button>
			</header>

			<div className="flex min-h-0 min-w-0 flex-1">
				{/* Section list, shown only at the first navigation level. */}
				<nav
					aria-label="Settings sections"
					data-testid="settings-nav"
					className={`${phoneLevel === "list" ? "flex" : "hidden"} min-w-0 w-full shrink-0 flex-col gap-1 overflow-y-auto p-2`}
				>
					{SECTIONS.map((s) => (
						<button
							key={s.id}
							type="button"
							data-testid={`settings-nav-${s.id}`}
							aria-current={active === s.id}
							className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 py-3 text-left text-sm ${
								active === s.id
									? "bg-accent text-foreground"
									: "text-muted-foreground hover:bg-accent hover:text-foreground"
							}`}
							onClick={() => {
								setActive(s.id);
								setPhoneLevel("section");
							}}
						>
							{s.label}
							<span aria-hidden="true" className="text-lg text-muted-foreground">›</span>
						</button>
					))}
				</nav>

				{/* Content column — one section at a time, this scrolls — and
				    LOCKS while any MenuShell is open (owner ruling: no
				    scrolling with a dropdown down; MenuShell announces
				    open/close, the count keeps overlap honest). The lock
				    intercepts wheel/touch instead of hiding the scrollbar —
				    nothing may shift when the lock engages. */}
				<div
					ref={contentRef}
					className={`@container min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto ${phoneLevel === "section" ? "block" : "hidden"}`}
					data-testid="settings-content"
				>
					{error && (
						<p
							role="alert"
							className="m-4 rounded-md border border-wrong px-3 py-2 text-sm text-wrong"
							data-testid="settings-error"
						>
							{error}
						</p>
					)}
					{record === undefined ? (
						<p className="px-6 py-5 text-xs text-muted-foreground/70">
							Loading settings…
						</p>
					) : record === null ? (
						<p className="px-6 py-5 text-xs text-muted-foreground/70">
							Settings could not be loaded — refresh to retry.
						</p>
					) : (
						<div>
							{active === "keys" && (
								<SettingsSection title="Providers" testid="section-keys">
									<ProvidersSection />
								</SettingsSection>
							)}
							{active === "agent" && (
								<SettingsSection
									title="Agent"
									testid="section-agent"
								>
									<AgentSection
										agent={record.agent}
										models={record.models}
										graph={record.graph}
										compaction={record.compaction}
										onModelsChange={(next: ModelsSettings) =>
											void write("models", next)
										}
										onSectionChange={(next: AgentSettings) =>
											void write("agent", next)
										}
										onCompactionChange={(next: CompactionSettings) =>
											void write("compaction", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "appearance" && (
								<SettingsSection
									title="Appearance"
									testid="section-appearance"
								>
									<AppearanceSection
										appearance={record.appearance}
										onSectionChange={(next: AppearanceSettings) =>
											void write("appearance", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "graph" && (
								<SettingsSection
									title="Graph"
									testid="section-graph"
								>
									<GraphSection
										graph={record.graph}
										onSectionChange={(next: GraphSettings) =>
											void write("graph", next)
										}
									/>
								</SettingsSection>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
