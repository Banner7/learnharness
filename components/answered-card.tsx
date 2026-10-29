"use client";

import { useState } from "react";
import { ConfidenceRail } from "@/components/confidence-rail";
import { GlyphMark } from "@/components/ui/glyph-mark";
import { ThinkingBlock } from "@/components/thinking-block";
import { PathText } from "@/components/file-path-chip";
import { cn } from "@/lib/utils";
import { ToolContentResponse } from "@/components/ai-elements/message";
import type { QuestionAnswerData } from "@/src/core";
import { answerForPresentation, parseAskInput, parseQuizInput } from "@/src/core";

/**
 * Static rendering of an answered question (tool part in `output-available`).
 *
 * Quiz answers are GRADED: ✓/✗ marks, the correct answers, and the
 * explanation. Ask answers are NOT graded — a plain record of what was said.
 * (The v1 bug this pins: ask answers must never get quiz grading UI.)
 * Explain answers are graded by the MODEL in its next reply, not by the
 * client — the card reveals his answer, the committed correct answer, and
 * the explanation, with NO verdict chips (owner ruling 2026-09-27).
 */
export function AnsweredCard({ answer: savedAnswer, input }: { answer: QuestionAnswerData; input?: unknown }) {
	const answer = answerForPresentation(savedAnswer, input);
	const [whyOpen, setWhyOpen] = useState(false); // the tucked explanation (predictions, owner 2026-10-03)
	if (answer.dismissed) {
		return (
			<div className="rounded-lg border border-border p-4 font-ui text-sm text-muted-foreground">
				<span className="font-medium">{answer.questionText}</span> — skipped
			</div>
		);
	}

	const isQuiz = answer.kind === "quiz";
	const isExplain = answer.kind === "explain";
	const selectedIdx = new Set(answer.answers.map((a) => a.index));
	const correctIdx = new Set(answer.correctIndices ?? []);
	// Redesign (owner, 2026-10-27): resolve the learner's choices through
	// projected option labels so historical math repairs reach the summary.
	const learnerAnswer = answer.dontKnow
		? "I don't know"
		: answer.answers
				.map((a) => answer.options?.find((opt) => opt.index === a.index)?.label ?? a.label)
				.concat(answer.other ? [answer.other] : [])
				.join(", ");
	const correctAnswer = answer.options
		?.filter((opt) => correctIdx.has(opt.index))
		.map((opt) => opt.label)
		.join(", ");
	// The question's own context rides the ORIGINAL CALL, not the answer
	// snapshot (owner, 2026-10-12): the details line — and, for ask
	// questions, option descriptions — re-render from the persisted
	// arguments, so every existing transcript shows them too. The lean
	// snapshot (what the model sees, compactAnswerForModel) is untouched;
	// any parse failure or absent input renders exactly the older card.
	const askInput = answer.kind === "ask" ? parseAskInput(input) : undefined;
	const parsedDetails = askInput?.details ?? (answer.kind === "quiz" ? parseQuizInput(input)?.details : undefined);
	const descByIndex = new Map((askInput?.options ?? []).map((o, i) => [i + 1, o.description]));

	return (
		<>
		{/* The reading channel LIFTED (owner round, 2026-10-05): thoughts
		    captured while reading are chronologically PRIOR to the question —
		    rendered as its own user-side block ABOVE the card, the unified
		    ThinkingBlock, instead of an inset inside the answer. Same muted
		    rail as before; the label is now plain "Your thinking". */}
		{answer.readingThinking && (
			<ThinkingBlock testId="reading-thinking-block" label="Your thinking" text={answer.readingThinking} defaultOpen />
		)}
		{/* [&>*:last-child]:mb-0 (owner round, 2026-10-07): on ask cards the
		    thinking row is the last child — its my-3 stacked with the card's
		    p-4 into a 28px void below (12px above); the card's own padding is
		    the bottom rhythm when a row ends the card. */}
		<div
			className="rounded-lg border border-border p-4 font-ui text-foreground [&>*:last-child]:mb-0"
			data-testid="answered-card"
		>
			<div className="mb-2 font-ui text-xs text-muted-foreground">
				{/* The tool's OWN name first (owner 2026-10-09): probe-phase
			    cards label Probe/Recall — the phase boundary visible in the
			    transcript. No `tool` on old records: kind labels as before. */}
				{answer.tool === "probe"
					? "Probe"
					: answer.tool === "recall"
						? "Recall"
						: isQuiz
								? answer.questionType === "predict"
									? "Prediction"
									: "Check"
									: isExplain
										? "Explain"
											: "Question"}
			</div>
			<div className="mb-3 font-prose text-lg">
				<ToolContentResponse>{answer.questionText}</ToolContentResponse>
			</div>
			{parsedDetails && (
				<div className="mb-3 font-prose text-sm text-muted-foreground">
					<ToolContentResponse>{parsedDetails}</ToolContentResponse>
				</div>
			)}
			{isQuiz && (
				<div className="mb-2">
					<div className="flex items-center gap-3 font-ui text-base">
						<div className="min-w-0 text-learner"><ToolContentResponse className="!font-ui [&>p:first-child]:m-0">{learnerAnswer}</ToolContentResponse></div>
						{!answer.dontKnow && (
							<span aria-hidden className={answer.correct ? "text-correct" : "text-wrong"}>
								{answer.correct ? "✓" : "✗"}
							</span>
						)}
						<span className={answer.dontKnow ? "text-muted-foreground" : answer.correct ? "text-correct" : "text-wrong"}>
							{answer.dontKnow ? "Didn't know" : answer.correct ? "Correct" : "Not quite"}
						</span>
					</div>
					<div className="font-ui text-sm text-muted-foreground">
						{answer.confidence != null && `You were ${answer.confidence}% sure. `}
						{!answer.correct && correctAnswer && <>Correct answer: <ToolContentResponse className="inline [&>p:first-child]:inline [&>p:first-child]:m-0">{correctAnswer}</ToolContentResponse></>}
					</div>
				</div>
			)}

			{(!isQuiz || (answer.correctIndices?.length ?? 0) > 1) && ((answer.options?.length ?? 0) > 0 || answer.other) && (
				<div className="flex flex-col gap-1 text-base">
					{answer.options?.map((opt) => {
						const sel = selectedIdx.has(opt.index);
						const key = isQuiz && correctIdx.has(opt.index);
						return (
							<div
								key={opt.index}
								className="flex items-center gap-2 border-b border-border px-1 py-2"
							>
								{/* Redesign (2026-10-29): the tutor's option text stays prose; only the chosen letter is filled. */}
								<span aria-hidden className={cn(
									"grid size-7 shrink-0 place-items-center rounded-full border border-border font-ui text-sm text-muted-foreground",
									sel && "border-primary bg-primary text-primary-foreground",
								)}>{String.fromCharCode(64 + opt.index)}</span>
								{isQuiz && (
									// Zapf-Dingbats-derived SVG outlines — the exact LaTeX \ding{51}/
									// \ding{55} hand-drawn shapes (owner, round 6); see ui/glyph-mark.
									<span
										aria-hidden
										data-mark={sel && key ? "check" : sel && !key ? "x" : !sel && key ? "check" : undefined}
										className={cn(
											"flex shrink-0 items-center",
											sel && key && "text-correct",
											sel && !key && "text-wrong",
											!sel && key && "text-correct",
										)}
									>
										{/* Owner round 8: a touch smaller than the text (size-4→size-3.5,
											   ≈14px vs the 16px row) while centered. */}
										{(key || sel) && <GlyphMark kind={key ? "check" : "x"} className="size-3.5" />}
									</span>
								)}
								<span className={cn("min-w-0 font-prose", sel ? "font-semibold text-foreground" : "text-muted-foreground")}>
									<ToolContentResponse>{opt.label}</ToolContentResponse>
									{descByIndex.get(opt.index) && (
										// Ask-option subtext (owner, 2026-10-12): same markdown path
										// as the pending dock — LaTeX included. Quiz options carry
										// none (owner ruling 2026-09-26); the map stays empty for them.
										<ToolContentResponse className="block text-xs text-muted-foreground">
											{descByIndex.get(opt.index)}
										</ToolContentResponse>
									)}
								</span>
							</div>
						);
					})}
					{/* The learner's own typed option is an OPTION — same container,
					    same selected styling as its siblings, not a loose quote
					    floating outside the list. Quotes keep the learner's words. */}
					{answer.other && (
						<div
							data-testid="answered-other"
							className="flex items-center gap-2 border-b border-border px-1 py-2 text-learner"
						>
							<span>“<PathText text={answer.other} />”</span>
						</div>
					)}
				</div>
			)}

			{answer.text && <div className="lh-learner mt-2 whitespace-pre-wrap">“<PathText text={answer.text} />”</div>}

			{/* Redesign (owner, 2026-10-27): the static rail records confidence
			    without a thumb; the sentence above gives the same value in words. */}
			{isQuiz && answer.confidence != null && (
				<div className="mt-3 flex items-center gap-3" data-testid="answered-confidence">
					<ConfidenceRail value={answer.confidence} className="min-w-0 flex-1" />
					<span className="w-10 shrink-0 text-right font-ui text-sm font-semibold tabular-nums text-learner">
						{answer.confidence}%
					</span>
				</div>
			)}

			{(answer.thinking ?? answer.note) && (
				/* Redesign (owner, 2026-10-27): keep the disclosure and its
				   test id while opening the learner's quoted reasoning. */
				<ThinkingBlock
					testId="your-thinking"
					label="Your thinking"
					text={`“${answer.thinking ?? answer.note ?? ""}”`}
					inCard
					defaultOpen
				/>
			)}

			{/* px-3→removed: card p-4 + box px-3 double-inset sat the "Why" label deeper
			    than the option box edges (owner, round 3). Sides flush with everything
			    else; py-2 stays for vertical air. */}
			{isQuiz && answer.explanation && (
				/* The TUCKED explanation — ALL questions (owner, 2026-10-07): the
				   verdict shows, the explanation sits collapsed behind the Why
				   toggle — viewable, never center stage. Identical to the
				   prediction pattern it generalizes (owner, 2026-10-03). */
				<div className="mt-2" data-testid="tucked-explanation">
					<button
						type="button"
						onClick={() => setWhyOpen((v) => !v)}
						className="min-h-11 text-xs font-medium text-muted-foreground hover:text-foreground"
					>
						{whyOpen ? "Hide why" : "Why"}
					</button>
					{whyOpen && (
						<div className="mt-1.5 py-2 font-prose text-sm text-muted-foreground">
							<span className="font-medium text-muted-foreground">Why: </span>
							{/* Keep the first paragraph beside the label, not every paragraph:
							   later paragraphs must retain their recovered document structure. */}
							<ToolContentResponse className="inline [&>p:first-child]:inline [&>p:first-child]:m-0">{answer.explanation}</ToolContentResponse>
						</div>
					)}
				</div>
			)}

			{/* The explain reveal (owner ruling 2026-09-27): the committed answer
			    — one field, reasoning included — shown on submit; no verdict,
			    the model's next reply IS the grading. */}
			{isExplain && answer.committed && (
				<div className="mt-3 border-t border-border py-2 font-prose text-sm text-muted-foreground">
					<span className="font-medium text-foreground">The answer: </span>
					<ToolContentResponse className="inline [&>p:first-child]:inline [&>p:first-child]:m-0">{answer.committed}</ToolContentResponse>
				</div>
			)}
		</div>
		</>
	);
}
