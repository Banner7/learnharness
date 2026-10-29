"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { PathInput } from "@/components/path-input";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { tap } from "@/lib/haptics";
import { HapticLabel } from "@/components/ui/haptic";
import {
	buildAnswer,
	normalizeQuizType,
	CONFIDENCE_STOPS,
	DEFAULT_CONFIDENCE_INDEX,
	emptyDockSelection,
	normalizeOptions,
	resolveCorrect,
	seededRandom,
	shuffleOptions,
	toolQuestionKind,
	parseAskInput,
	parseQuizInput,
	parseExplainInput,
	toggleOption,
	toggleOther,
	type AnswerRequest,
	type AskToolInput,
	type DockSelection,
	type ExplainToolInput,
	type QuestionAnswerData,
	type QuestionFormDraft,
	type QuestionData,
	type QuestionMode,
	type QuizToolInput,
	type SelectMode,
	type Phase3,
} from "@/src/core";
import { confidenceRailStyle } from "@/components/confidence-rail";

/** An in-flow question card with answer options and a thinking field. */

export interface QuestionDockProps {
	toolName: "quiz" | "probe" | "ask_user_question" | "explain" | "recall";
	toolCallId: string;
	input: QuizToolInput | AskToolInput | ExplainToolInput;
	onSubmit: (output: QuestionAnswerData) => void;
	/** Restore only this call's unconfirmed submission after recovery. */
	initialDraft?: QuestionFormDraft;
	onSaveDraft?: (draft: QuestionFormDraft) => void;
	/** Session phase at the question — scales the thinking field: probing
	 *  stays quick (one row), teaching invites dumping (three rows). */
	phase?: Phase3;
	/** Compaction is running for this chat (owner round 14): the answer
	 *  POST would block on the server's compaction gate — disable submit
	 *  and say so in the hint row. The server registry is the real gate;
	 *  this is the affordance. */
	compactionRunning?: boolean;
}

export function QuestionDock({
	toolName,
	toolCallId,
	input,
	onSubmit,
	initialDraft,
	onSaveDraft,
	phase = "probe",
	compactionRunning = false,
}: QuestionDockProps) {
	// The probe-phase names (owner, 2026-10-09) canonicalize onto their
	// teach twins for every dock concern — parse dispatch, labels, kinds:
	// the probe quiz ("probe") is quiz-shaped, the probe free-recall
	// ("recall") is explain-shaped. Old records keep the teach names.
	const canonical =
		toolName === "probe" ? "quiz" : toolName === "recall" ? "explain" : toolName;
	// Parse, don't cast (src/core/tool-parts.ts): the model authored this
	// input, and only the schema the tool declared vouches for its shape.
	// The dock mounts on input-available parts (already validated at the
	// bridge), so this is pure defense in depth — but it is STRUCTURAL now:
	// anything that slips through renders the quiet fallback, never a
	// crash on `.map` over model-authored bytes.
	const parsed =
		canonical === "quiz" ? parseQuizInput(input) : canonical === "explain" ? parseExplainInput(input) : parseAskInput(input);
	if (!parsed) {
		return (
			<div data-testid="malformed-question" className="rounded-xl border border-dashed bg-card/60 p-3 text-sm text-muted-foreground">
				This question arrived malformed — the transcript keeps the retry.
			</div>
		);
	}
	return (
		<QuestionDockForm
			toolName={toolName}
			toolCallId={toolCallId}
			input={parsed}
			phase={phase}
			onSubmit={onSubmit}
			initialDraft={initialDraft}
			onSaveDraft={onSaveDraft}
			compactionRunning={compactionRunning}
		/>
	);
}

/** The expanded question: label, question, options, and the unified bottom row. */
function QuestionDockForm({
	toolName,
	toolCallId,
	input,
	phase = "probe",
	onSubmit,
	initialDraft,
	onSaveDraft,
	compactionRunning = false,
}: QuestionDockProps) {
	const kind = toolQuestionKind(toolName);

	// Canonical QuestionData, built once per question. Quiz options are
	// deterministically shuffled (seeded by toolCallId) so position never leaks
	// correctness AND server/client render the same order (hydration-safe);
	// the display order is snapshotted into the answer record at submit time.
	const qd = useMemo<QuestionData>(() => {
		const quizInput = kind === "quiz" ? (input as QuizToolInput) : null;
		const askInput = kind === "ask" ? (input as AskToolInput) : null;
		const explainInput = kind === "explain" ? (input as ExplainToolInput) : null;
		const multi = input instanceof Object && "multiSelect" in input ? input.multiSelect === true : false;
		const mode: QuestionMode =
			kind === "quiz"
				? multi
					? "multi-select"
					: "single-select"
				: askInput?.options?.length
					? multi
						? "multi-select"
						: "single-select"
						: "text";
		const options = normalizeOptions(
			(quizInput?.options ?? askInput?.options ?? []) as { label: string; value?: string }[],
		);
		const ordered = kind === "quiz" && options.length > 0 ? shuffleOptions(options, seededRandom(toolCallId)) : options;
		const q: QuestionData = {
			id: toolCallId,
			kind,
			// The role (owner 2026-10-03): predict questions gate by it in the
			// view (never collapsed) and the answered card tucks the explanation.
			questionType: kind === "quiz" ? normalizeQuizType((input as { type?: unknown }).type) : undefined,
			question: input.question,
			context: input.details,
			mode,
			options: ordered,
			createdAt: new Date().toISOString(),
		};
		if (quizInput) {
			const resolved = resolveCorrect(quizInput.correctAnswer, ordered);
			if (resolved.error) console.error("[quiz] correctAnswer did not resolve:", resolved.error);
			q.correctIndices = resolved.indices;
			q.explanation = quizInput.explanation;
		}
		if (explainInput) {
			// The commitment rides the question data (never sent to the
			// client before answering) and snapshots into the answer at submit.
			// One field, reasoning included — no separate explanation
			// (owner ruling 2026-09-27).
			q.committedAnswer = explainInput.correctAnswer;
		}
		return q;
	}, [toolCallId, kind, input]);

	// The selection state machine lives in question-core (pure, tested):
	// single-select displaces, multi-select coexists — picking the ask
	// "Other…" row in a multi-select must never clear already-picked
	// options, and picking an option must never clear a typed custom answer.
	const [sel, setSel] = useState<DockSelection>(() => initialDraft?.selection ?? emptyDockSelection());
	// The learner's transfer channel — thinking, never "a note".
	const [thinking, setThinking] = useState(initialDraft?.thinking ?? "");
	const [other, setOther] = useState(initialDraft?.other ?? "");
	const [text, setText] = useState(initialDraft?.text ?? "");
	// Confidence (owner, 2026-10-01): an index into CONFIDENCE_STOPS,
	// resting at 50 — a real coin flip by definition, untouched or
	// deliberate (the same number, the same meaning). The dock unmounts
	// between questions, so each question starts fresh at 50.
	const [confIdx, setConfIdx] = useState<number>(initialDraft?.confidenceIndex ?? DEFAULT_CONFIDENCE_INDEX);
	const selectMode: SelectMode = qd.mode === "multi-select" ? "multi-select" : "single-select";

	const toggle = (idx: number) => setSel(toggleOption(selectMode, sel, idx));

	const canSubmit =
		qd.mode === "text"
			? text.trim().length > 0
			: sel.dontKnow || (sel.otherSelected && other.trim().length > 0) || sel.selected.size > 0;

	const submit = () => {
		if (!canSubmit || compactionRunning) return;
		tap();
		const req: AnswerRequest = {
			dontKnow: sel.dontKnow,
			values: [...sel.selected].map((i) => qd.options[i]!.value),
			other: sel.otherSelected ? other : undefined,
			text: qd.mode === "text" ? text : undefined,
			thinking: qd.mode !== "text" ? thinking.trim() || undefined : undefined,
			// Always sent on quiz answers (owner: 50 must mean 50, never
			// "untouched"); buildAnswer drops it on "I don't know".
			confidence: kind === "quiz" ? CONFIDENCE_STOPS[confIdx] : undefined,
		};
		// Snapshot before optimistic submission unmounts the form (upstream
		// 0.3.8; the fork has no dictation, so plain state is current).
		onSaveDraft?.({
			selection: { ...sel, selected: new Set(sel.selected) },
			thinking,
			other,
			text,
			confidenceIndex: confIdx,
		});
		onSubmit(buildAnswer(qd, req, toolName));
	};


	// Selecting Other never clears the thinking field — two channels, the
	// answer and the reasoning behind it, side by side.
	const selectOther = () => setSel(toggleOther(selectMode, sel));



	return (
		// The board (redesign 2026-10-29): the open question is written on
		// the board — .lh-board re-points every token inside to chalk on
		// slate, and the panel rises once when the question arrives.
		<div data-testid="question-dock" className="lh-board lh-board-enter rounded-xl p-5">
			<div data-session-find-root="">
				<div className="mb-2 text-sm text-primary">
					{toolName === "probe"
						? "Probe"
						: toolName === "recall"
							? "Recall"
							: kind === "quiz"
								? qd.questionType === "predict"
									? "Prediction"
									: "Check"
									: kind === "explain"
										? "Explain"
											: "Question"}
					{qd.mode === "multi-select" && <span className="text-muted-foreground"> (select all that apply)</span>}
				</div>
				<div className="mb-4 font-prose text-xl">
					<ToolContentResponse>{qd.question}</ToolContentResponse>
				</div>
				{qd.context && (
					<div className="mb-3 font-prose text-sm text-muted-foreground">
						<ToolContentResponse>{qd.context}</ToolContentResponse>
					</div>
				)}

				{qd.mode !== "text" && (
					<div className="flex flex-col gap-2 pb-2" role={qd.mode === "multi-select" ? "group" : "radiogroup"}>
						{qd.options.map((opt, i) => {
							const isSel = sel.selected.has(i);
							return (
								<button
									key={opt.value}
									type="button"
									role={qd.mode === "multi-select" ? "checkbox" : "radio"}
									aria-checked={isSel}
									onClick={() => {
										tap();
										toggle(i);
									}}
									className={cn(
										"relative flex min-h-13 w-full items-start gap-3 rounded-lg bg-muted px-3 py-2.5 text-left font-prose text-lg outline-none hover:bg-accent",
										isSel && "bg-highlight text-highlight-foreground hover:bg-highlight",
									)}
								>
									{/* Options are a real sequence, so they carry letters. */}
									<span
										aria-hidden
										className={cn(
											"mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-current font-ui text-sm",
											isSel && "border-primary bg-primary text-primary-foreground",
										)}
									>
										{String.fromCharCode(65 + i)}
									</span>
									<span>
										<ToolContentResponse>{opt.label}</ToolContentResponse>
										{kind !== "quiz" && opt.description && (
											// Redesign (owner, 2026-10-27): option descriptions
											// remain prose; quiz descriptions still stay hidden so
											// they cannot telegraph correctness.
											<ToolContentResponse className="block font-prose text-sm text-muted-foreground">
												{opt.description}
											</ToolContentResponse>
										)}
									</span>
									<HapticLabel />
								</button>
							);
						})}

						{kind === "quiz" && (
							<button
								type="button"
								onClick={() => {
									tap();
									setSel((prev) => ({ ...prev, selected: new Set(), otherSelected: false, dontKnow: !prev.dontKnow }));
								}}
								aria-pressed={sel.dontKnow}
								className={cn(
									// Redesign (owner, 2026-10-27): uncertainty is a
									// full-width option, not a visually separate action.
									"relative flex min-h-13 w-full items-center rounded-lg bg-muted px-3 py-2.5 text-left font-ui text-base text-muted-foreground outline-none hover:bg-accent",
									sel.dontKnow && "bg-highlight text-highlight-foreground hover:bg-highlight",
								)}
							>
								<span>I don't know</span>
								<HapticLabel />
							</button>
						)}

						{kind === "ask" && (
							<div
								role={qd.mode === "multi-select" ? "checkbox" : "radio"}
								aria-checked={sel.otherSelected}
								data-testid="other-option"
								onClick={() => {
									tap();
									selectOther();
								}}
								className={cn(
									"flex min-h-13 w-full items-center rounded-lg bg-muted px-3 py-2.5 text-left outline-none hover:bg-accent",
									sel.otherSelected && "bg-highlight text-highlight-foreground hover:bg-highlight",
								)}
							>
								<PathInput singleLine
									value={other}
									onValueChange={(value) => {
										setOther(value);
										// Typing selects the row — displacing in
										// single-select, alongside the siblings in multi.
										setSel((prev) => (prev.otherSelected ? prev : toggleOther(selectMode, prev)));
									}}
									placeholder="Type your own answer…"
									className="lh-input w-full min-w-0 flex-1 bg-transparent font-ui outline-none placeholder:text-muted-foreground"
									onClick={(e) => e.stopPropagation()}
								/>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Redesign (owner, 2026-10-27): confidence stays a real
			    snapped probability, with one primary fill in either mode.
			    "I don't know" disables it and sends no value. */}
			{kind === "quiz" && (
				<div className="py-3">
					<div className="flex items-center gap-3">
						<span
							className={cn(
								"shrink-0 text-xs",
								sel.dontKnow ? "text-muted-foreground/50" : "text-muted-foreground",
							)}
						>
							How sure are you?
						</span>
						<div
							className={cn("relative h-11 min-w-0 flex-1", sel.dontKnow && "opacity-40")}
							data-testid="confidence-track"
						>
							{/* The fill spans the thumb-center range while the
							    native range input keeps touch and keyboard behavior. */}
							<div
								aria-hidden
								data-testid="confidence-rail"
								className="pointer-events-none absolute top-1/2 left-2 right-2 h-1.5 -translate-y-1/2 rounded-full bg-muted"
							>
								<div className="h-full rounded-full bg-primary" style={confidenceRailStyle(CONFIDENCE_STOPS[confIdx]!)} />
							</div>
							<input
								type="range"
								min={0}
								max={100}
								step={1}
								value={CONFIDENCE_STOPS[confIdx]}
								disabled={sel.dontKnow}
								aria-label="Confidence — the probability your selected answer is correct"
								aria-valuetext={`${CONFIDENCE_STOPS[confIdx]} percent`}
								title="The probability your selected answer is correct — 50% is a coin flip."
								data-testid="confidence-slider"
								onChange={(e) => {
									// Snap to the nearest stop while keeping its true fraction.
									const v = Number(e.target.value);
									let best = 0;
									for (let i = 1; i < CONFIDENCE_STOPS.length; i++) {
										if (Math.abs(CONFIDENCE_STOPS[i]! - v) < Math.abs(CONFIDENCE_STOPS[best]! - v)) best = i;
									}
									if (best !== confIdx) tap();
									setConfIdx(best);
								}}
								className={cn(
									"absolute inset-0 h-11 w-full cursor-pointer appearance-none bg-transparent outline-none",
									"[&::-webkit-slider-runnable-track]:h-11 [&::-webkit-slider-runnable-track]:bg-transparent",
									"[&::-webkit-slider-thumb]:mt-3.5 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-card",
									"[&::-moz-range-track]:h-11 [&::-moz-range-track]:bg-transparent",
									"[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-card",
								)}
							/>
						</div>
						<span
							data-testid="confidence-value"
							className={cn(
								"w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-primary",
								sel.dontKnow && "text-muted-foreground/50",
							)}
						>
							{sel.dontKnow ? "—" : `${CONFIDENCE_STOPS[confIdx]}%`}
						</span>
					</div>
				</div>
			)}

			{/* Redesign (owner, 2026-10-27): a quiet reasoning line lets
			    the primary submit button remain the clear final action.
			    Text answers retain Enter-to-submit. */}
			<form
				className="pt-2"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div
					data-testid={qd.mode === "text" ? "answer-field" : "thinking-field"}
					className="border-b border-dashed border-border focus-within:border-primary"
				>
					{qd.mode === "text" && (
						<div className="pt-2 text-xs font-medium text-muted-foreground">Your answer</div>
					)}
					{qd.mode === "text" ? (
						<PathInput
							value={text}
							onValueChange={setText}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									submit();
								}
							}}
							placeholder="Type your answer…"
							className="field-sizing-content lh-input max-h-48 min-h-11 w-full resize-none bg-transparent px-1 py-2 outline-none placeholder:text-muted-foreground"
						/>
					) : (
						<PathInput
							value={thinking}
							onValueChange={setThinking}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									submit();
								}
							}}
							placeholder="Why this answer? Whatever comes to mind."
							className={cn(
								"field-sizing-content lh-input max-h-48 min-h-11 w-full resize-none bg-transparent px-1 py-2 outline-none placeholder:text-muted-foreground",
								phase === "teach" ? "min-h-16" : "min-h-11",
							)}
						/>
					)}
				</div>
				<div className="pt-3">
					{compactionRunning && <span className="text-xs text-muted-foreground">Compacting session…</span>}
					<Button
						type="submit"
						disabled={!canSubmit || compactionRunning}
						className="relative min-h-11 w-full rounded-md text-sm font-semibold"
					>
						Submit answer
						<HapticLabel />
					</Button>
				</div>
			</form>
		</div>
	);
}
