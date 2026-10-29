"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "@/web/navigation";
import { SettingsIcon } from "lucide-react";
import { tap } from "@/lib/haptics";
import { HapticLabel } from "@/components/ui/haptic";
import { MinimalHome } from "@/components/minimal-home";
import { Composer } from "@/components/composer";
import { ComposerActions, NodePickerControl } from "@/components/composer-actions";
import { SidebarToggle } from "@/components/sidebar";
import { ModelControl } from "@/components/model-picker";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { OPENING_PROMPT_FAILURE } from "@/components/opening-prompt";
import { SessionStarter } from "@/components/start-session";

/** Redesign (owner, 2026-10-27): one composer-led home for both color modes. */
export function Home() {
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const [topic, setTopic] = useState("");
	const topicRef = useRef("");
	const [busy, setBusy] = useState(false);
	const startingRef = useRef(false);
	const starterRef = useRef(new SessionStarter());
	const [startError, setStartError] = useState(false);
	const topicInputRef = useRef<HTMLDivElement>(null);

	/* Practice creation can include propositions selected from the chain table. */
	const [mode, setMode] = useState<"teach" | "practice">("teach");
	const [practiceProps, setPracticeProps] = useState<{ id: string; name: string; statement: string }[]>([]);
	const [chainSelectOpen, setChainSelectOpen] = useState(false);
	// The chain table is CONTROLLED off this id set (the lifted pick).
	const pickedIds = useMemo(() => new Set(practiceProps.map((p) => p.id)), [practiceProps]);

	const start = () => {
		tap();
		void begin();
	};
	const begin = async () => {
		const t = topicRef.current.trim();
		if (!t || startingRef.current) return;
		startingRef.current = true;
		setBusy(true);
		setStartError(false);
		try {
			// The map context (owner, 2026-10-04): picks in EITHER mode ride
			// the CREATION as graphContext — the server writes a
			// graph-context marker as message[0] (a separate custom message
			// before the learner's first user message, propositions + the
			// chains among them); the prompt stays the learner's own words.
			// Upstream 0.3.9 keys reuse on the setup catalog's Strong slot; this
			// fork has no setup catalog here, so reuse keys on the body alone
			// (0.3.9 port, 2026-10-28).
			const target = await starterRef.current.start({
				title: t,
				...(mode === "practice" ? { kind: "practice" } : {}),
				...(practiceProps.length > 0 ? { graphContext: { propositions: practiceProps } } : {}),
			}, fetch);
			router.push(target);
		} catch {
			startingRef.current = false;
			setBusy(false);
			setStartError(true);
		}
	};

	return (
		<div className="h-dvh overflow-y-auto">
			<header className="mx-auto flex max-w-[720px] items-center justify-between px-4 pt-[calc(0.5rem+env(safe-area-inset-top))]">
				<SidebarToggle />
				<button type="button" aria-label="Settings" onClick={() => openSettings()} className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
					<SettingsIcon className="size-5" />
				</button>
			</header>
			<MinimalHome
				chainSelectOpen={chainSelectOpen}
				practiceSelection={pickedIds}
				onPracticeSelectionChange={setPracticeProps}
				onChainSelectClose={() => setChainSelectOpen(false)}
			>
				<section className="pt-7">
					<h1 className="mb-6 font-title text-3xl leading-tight text-foreground">What do you want to learn?</h1>
					{startError && <p role="alert" className="mb-2 text-sm text-destructive">{OPENING_PROMPT_FAILURE}</p>}
					<Composer
						variant="home"
						busy={busy}
						value={topic}
						onChange={(value) => {
							topicRef.current = value;
							setTopic(value);
						}}
						onSend={start}
						onStop={() => {}}
						canSend={topic.trim().length > 0}
						inputRef={topicInputRef}
						placeholder="A topic, a question, or paste notes"
						autoFocus
						actions={<div className="flex items-center justify-between gap-2">
							<div className="flex items-center rounded-md bg-muted p-1" data-testid="home-mode-switch">
								{(["teach", "practice"] as const).map((m) => (
									<button
										key={m}
										type="button"
										data-testid={`home-mode-${m}`}
										aria-pressed={mode === m}
										onClick={() => setMode(m)}
										className={"min-h-11 rounded-md px-3 text-sm font-medium " + (mode === m ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground")}
									>
										{m === "teach" ? "Teach me" : "Practice"}
									</button>
								))}
							</div>
							<button type="submit" aria-label="Start session" disabled={!topic.trim() || busy} className="relative min-h-11 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-40">
								Start
								<HapticLabel />
							</button>
						</div>}
					/>
					<div className="mt-3 flex flex-wrap items-center justify-between gap-2">
						<ComposerActions picker={(practiceProps.length > 0 || mode === "practice") && (
							<NodePickerControl count={practiceProps.length} onOpen={() => setChainSelectOpen(true)} onClear={() => setPracticeProps([])} />
						)} />
						<div className="text-xs text-muted-foreground"><ModelControl /></div>
					</div>
				</section>
			</MinimalHome>
		</div>
	);
}
