/**
 * Render smoke tests — protocol tests don't see rendering. These render the
 * interaction cards to static HTML (react-dom/server). tsx uses the classic
 * JSX transform, so `React` must be a resolvable global.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionDock } from "../components/question-dock.tsx";
import { ProbeDoneCard } from "../components/artifacts/probe-done-card.tsx";
import { DispatchCard } from "../components/artifacts/dispatch-card.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import { ChatActionsContext } from "../components/chat.tsx";
import type { JobRecord } from "../src/core/contracts.ts";
import { AnsweredCard } from "../components/answered-card.tsx";
import {
	buildAnswer,
	normalizeOptions,
	resolveCorrect,
	type QuestionData,
} from "../src/core/question-core.ts";

const quizInput = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

function quizQD(): QuestionData {
	const options = normalizeOptions(quizInput.options);
	return {
		id: "q1",
		kind: "quiz",
		question: quizInput.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(quizInput.correctAnswer, options).indices,
		explanation: quizInput.explanation,
		createdAt: new Date().toISOString(),
	};
}

function askQD(): QuestionData {
	const options = normalizeOptions([{ label: "Very" }, { label: "Somewhat" }]);
	return {
		id: "a1",
		kind: "ask",
		question: "How confident are you?",
		mode: "single-select",
		options,
		createdAt: new Date().toISOString(),
	};
}

function renderDock(props: {
	toolName: "quiz" | "probe" | "ask_user_question" | "explain" | "recall";
	toolCallId: string;
	input: never;
}) {
	return renderToStaticMarkup(<QuestionDock {...props} onSubmit={() => {}} />);
}

const katexCount = (html: string) => (html.match(/class="katex"/g) ?? []).length;

describe("question submission draft restoration", () => {
	const draft = {
		selection: { selected: new Set([0]), otherSelected: true, dontKnow: false },
		thinking: "preserved reasoning",
		other: "preserved custom answer",
		text: "preserved free-text answer",
		confidenceIndex: 4,
	};

	it("restores a quiz selection, thinking, and confidence when its form remounts", () => {
		const html = renderToStaticMarkup(<QuestionDock toolName="quiz" toolCallId="q1" input={quizInput} onSubmit={() => {}} initialDraft={draft} />);
		assert.match(html, /role="radio" aria-checked="true"/);
		assert.ok(html.includes("preserved reasoning"));
		assert.ok(html.includes("90%"));
	});

	it("restores an ask's custom answer and a free-text answer", () => {
		const custom = renderToStaticMarkup(<QuestionDock toolName="ask_user_question" toolCallId="ask1" input={{ question: "Fixture?", options: [{ label: "Listed answer" }, { label: "Another answer" }], multiSelect: true }} onSubmit={() => {}} initialDraft={draft} />);
		assert.ok(custom.includes("preserved custom answer"));
		assert.match(custom, /aria-checked="true" data-testid="other-option"/);
		const text = renderToStaticMarkup(<QuestionDock toolName="ask_user_question" toolCallId="ask2" input={{ question: "Fixture?" }} onSubmit={() => {}} initialDraft={draft} />);
		assert.ok(text.includes("preserved free-text answer"));
	});
});

describe("DispatchCard: configuration refusals are not failures", () => {
	const job = (over: Partial<JobRecord>): JobRecord => ({
		id: "j1",
		kind: "research",
		chatId: "c1",
		toolCallId: "t1",
		status: "error",
		activity: "",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...over,
	});
	const render = (over: Partial<JobRecord>) => renderToStaticMarkup(
		<JobsContext.Provider value={[job(over)]}>
			<ChatActionsContext.Provider value={{ chatId: "c1", syncFromServer: async () => {}, sendText: () => {} }}>
				<DispatchCard toolCallId="t1" kind="research" />
			</ChatActionsContext.Provider>
		</JobsContext.Provider>,
	);

	it("models- and key-refused jobs render as refusals; a real error renders as failed", () => {
		for (const error of [
			"No model configured — set up your models first (missing: cheap)",
			"No OpenRouter credential is configured — configure it on the server",
		]) {
			const html = render({ error });
			assert.ok(html.includes('data-testid="dispatch-refused"'), error);
			assert.ok(!html.includes("failed"), error);
		}
		const failed = render({ error: "FAILED: headless crashed" });
		assert.ok(failed.includes('data-testid="dispatch-settled"'));
		assert.ok(failed.includes("failed"));
		assert.ok(!failed.includes("dispatch-refused"));
	});
});

describe("QuestionDock", () => {
	it("a quiz offers 'I don't know' via ARIA radios and never leaks the explanation before submit", () => {
		const html = renderDock({ toolName: "quiz", toolCallId: "q1", input: quizInput as never });
		assert.match(html, /I don&#x27;t know|I don't know/);
		assert.ok(!html.includes('type="radio"') && html.includes('role="radio"'), "button-based radios, not native inputs");
		assert.ok(!html.includes("innermost"), "explanation must not render pre-answer");
	});

	it("an ask has no 'I don't know' and offers an Other option row; multi-select uses checkboxes", () => {
		const single = renderDock({ toolName: "ask_user_question", toolCallId: "a1", input: { question: "How confident are you?", options: [{ label: "Very" }, { label: "Somewhat" }] } as never });
		assert.ok(!single.includes("I don&#x27;t know"));
		assert.ok(single.includes('data-testid="other-option"'));
		const multi = renderDock({ toolName: "ask_user_question", toolCallId: "m1", input: { question: "Which?", multiSelect: true, options: [{ label: "Physics" }, { label: "Philosophy" }] } as never });
		assert.ok((multi.match(/role="checkbox"/g) ?? []).length >= 3, "options AND the Other row are checkboxes");
	});

	it("a malformed question input renders the quiet fallback, never a crash", () => {
		const html = renderDock({
			toolName: "quiz",
			toolCallId: "bad",
			input: { question: "q?", options: JSON.stringify([{ label: "a" }, { label: "b" }]) } as never,
		});
		assert.ok(html.includes('data-testid="malformed-question"'));
	});

	it("math renders in the pending question, options, and ask option descriptions", () => {
		const quiz = renderDock({ toolName: "quiz", toolCallId: "m1", input: { ...quizInput, question: "What is $\\frac{dy}{dx}$ of $y = x^2$?" } as never });
		assert.ok(quiz.includes("katex"));
		const ask = renderDock({
			toolName: "ask_user_question",
			toolCallId: "d1",
			input: { question: "Which tool?", options: [{ label: "Pencil", description: "Wood around $\\text{Pb}_x$ — the classic $x^2$ choice." }, { label: "Pen" }] } as never,
		});
		assert.ok(katexCount(ask) >= 2);
		assert.ok(!ask.includes("$\\text"), "raw dollar delimiters do not leak");
	});
});

describe("AnsweredCard", () => {
	it("a wrong quiz pick reveals the correct answer and keeps the explanation behind its toggle", () => {
		const html = renderToStaticMarkup(<AnsweredCard answer={buildAnswer(quizQD(), { values: ["Venus"] })} />);
		assert.match(html, /Mercury/);
		assert.ok(html.includes("tucked-explanation"));
		assert.ok(!html.includes("innermost"), "explanation hidden until opened");
	});

	it("shows confidence only where one was sent (not on IDK or ask answers)", () => {
		const withConfidence = renderToStaticMarkup(<AnsweredCard answer={buildAnswer(quizQD(), { values: ["Venus"], confidence: 70 })} />);
		assert.match(withConfidence, /70%/);
		assert.ok(!withConfidence.includes('type="range"'), "a record, not a control");
		for (const answer of [buildAnswer(quizQD(), { values: [], dontKnow: true }), buildAnswer(askQD(), { other: "Shaky" })]) {
			assert.ok(!renderToStaticMarkup(<AnsweredCard answer={answer} />).includes("answered-confidence"));
		}
	});

	it("an ask answer is never graded and shows the learner's Other text", () => {
		const picked = renderToStaticMarkup(<AnsweredCard answer={buildAnswer(askQD(), { values: ["Somewhat"] })} />);
		assert.ok(!picked.includes("incorrect") && !picked.includes('data-mark="x"'));
		assert.match(picked, /Somewhat/);
		const other = renderToStaticMarkup(<AnsweredCard answer={buildAnswer(askQD(), { other: "shaky on applications" })} />);
		assert.match(other, /shaky on applications/);
	});

	it("renders the learner's thinking, the lifted reading thoughts, and a dismissal as skipped", () => {
		const html = renderToStaticMarkup(<AnsweredCard answer={buildAnswer(quizQD(), { values: ["Mercury"], thinking: "answering thought", readingThinking: "was unsure mid-paragraph" })} />);
		assert.ok(html.includes("was unsure mid-paragraph"));
		assert.ok(html.indexOf("reading-thinking-block") < html.indexOf("answered-card"), "reading thoughts sit above the card");
		const dismissed = { ...buildAnswer(quizQD(), { dontKnow: true }), dismissed: true };
		assert.match(renderToStaticMarkup(<AnsweredCard answer={dismissed} />), /skipped/);
	});

	it("an explain answer reveals the committed answer and the learner's text with no grading", () => {
		const qd: QuestionData = {
			id: "e1",
			kind: "explain",
			question: "Explain why the null result matters.",
			mode: "text",
			options: [],
			committedAnswer: "It ruled out the luminiferous aether.",
			createdAt: new Date().toISOString(),
		};
		const html = renderToStaticMarkup(<AnsweredCard answer={buildAnswer(qd, { text: "Something about relativity?" })} />);
		assert.match(html, /luminiferous aether/);
		assert.match(html, /Something about relativity\?/);
		assert.ok(!html.includes('data-mark="x"') && !html.includes('data-mark="check"'));
	});

	it("renders math in the persisted details line; legacy records without input get no context slot", () => {
		const input = {
			question: "Which destination?",
			details: "Inline $a^2+b^2=c^2$ and display:\n$$\nE = mc^2\n$$",
			options: [{ label: "Classical", description: "Entropy $H(X)$ first." }, { label: "ML toolkit" }],
		};
		const qd: QuestionData = { ...askQD(), question: input.question, options: normalizeOptions(input.options) };
		const html = renderToStaticMarkup(<AnsweredCard answer={buildAnswer(qd, { values: ["Classical"] })} input={input} />);
		assert.ok(katexCount(html) >= 3);
		assert.ok(html.includes("katex-display"));
		const legacy = renderToStaticMarkup(<AnsweredCard answer={buildAnswer(askQD(), { values: ["Very"] })} />);
		assert.equal(katexCount(legacy), 0);
	});
});

// The model once stringified `assessment` (a rejected input) and the card's
// preview trusted the shape; only pending/validated inputs may render.
describe("probe-done card", () => {
	const validAssessment = {
		strands: [{ strand: "modal logic basics", assessment: "Floor: solid intuition; ceiling: notation." }],
		summary: "Bracketed: teach the symbols on the intuition he has.",
	};

	it("renders strands from the call input (pending or settled), never from an ok-only output", () => {
		for (const part of [
			{ state: "output-available", input: { assessment: validAssessment }, output: { ok: true } },
			{ state: "input-available", input: { assessment: validAssessment } },
		]) {
			assert.match(renderToStaticMarkup(<ProbeDoneCard part={part as never} />), /modal logic basics/);
		}
		const echoless = renderToStaticMarkup(<ProbeDoneCard part={{ state: "output-available", output: { ok: true } } as never} />);
		assert.ok(!echoless.includes("modal logic basics"));
	});

	it("a rejected (stringified) assessment or a strandless partial never renders garbage or crashes", () => {
		const rejected = renderToStaticMarkup(
			<ProbeDoneCard part={{ state: "output-error", errorText: "Validation failed", input: { assessment: "strands: [{\"strand\": ...garbage" } } as never} />,
		);
		assert.ok(!rejected.includes("strands:"));
		renderToStaticMarkup(<ProbeDoneCard part={{ state: "input-streaming", input: { assessment: { summary: "…" } } } as never} />);
	});
});
