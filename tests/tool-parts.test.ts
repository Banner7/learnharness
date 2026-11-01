/**
 * Unit tests — the UI parse seam (src/core/tool-parts.ts).
 *
 * The rule born of the 2026-09-12 live crashes: model-authored tool input
 * is consumed only through these parsers, each running the SAME schema
 * the model faced at the boundary. These pins hold the live crash shapes
 * (the model's double-encoding habit) and the boundary-parity property:
 * anything a boundary schema accepts, the display parse accepts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { repairMathForDisplay, restoreMathEscapes } from "../src/core/math-delims.ts";
import {
	parseAskInput,
	parseProbeDoneInput,
	parseQuizInput,
	parseExplainInput,
} from "../src/core/tool-parts.ts";
import { quizInputSchema, probeQuizInputSchema } from "../src/core/question-core.ts";
import { probeDoneInputSchema } from "../src/core/contracts/probe.ts";

const TEACHER_QUIZ = {
	question: "What does Tarski's convention-T define?",
	options: [
		{ label: "Truth for a language", value: "truth" },
		{ label: "Provability", value: "provability" },
	],
	correctAnswer: "truth",
	explanation: "Convention-T schematizes truth for the object language.",
	type: "check", // teach-only role field — the display parse KEEPS it (the dock gates by it)
	nodeId: "convention-t", // teacher-only field — the display parse must accept and strip it
};

const PROBER_QUIZ = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

const VALID_ASSESSMENT = {
	assessment: {
		strands: [
			{ strand: "modal logic basics", assessment: "Floor: solid intuition; ceiling: notation." },
			{ strand: "indexical 'actual'", assessment: "Genuine floor — prior exposure likely." },
		],
		summary: "Bracketed: teach the symbols on the intuition he has.",
	},
};

/** A two-option quiz whose question is the field under test. */
const quizQuestion = (question: string) =>
	parseQuizInput({ question, options: [{ label: "yes" }, { label: "no" }], correctAnswer: "no", explanation: "" })?.question;

describe("parseQuizInput", () => {
	it("boundary parity: teach and probe quizzes parse; teacher-only nodeId is stripped, the role kept", () => {
		assert.ok(Value.Check(quizInputSchema, TEACHER_QUIZ), "fixture must be boundary-valid for this pin to mean anything");
		assert.ok(Value.Check(probeQuizInputSchema, PROBER_QUIZ));
		assert.ok(parseQuizInput(PROBER_QUIZ));
		const parsed = parseQuizInput(TEACHER_QUIZ);
		assert.ok(parsed);
		assert.equal(parsed.question, TEACHER_QUIZ.question);
		assert.equal((parsed as Record<string, unknown>).nodeId, undefined, "unknown keys are stripped, not trusted");
		assert.equal((parsed as { type?: unknown }).type, "check");
	});

	it("boundary parity: the string-options shape heals on read (the boundary heals it at every registry)", () => {
		const parsed = parseQuizInput({ ...PROBER_QUIZ, options: JSON.stringify(PROBER_QUIZ.options) });
		assert.ok(parsed, "the healed-at-boundary record must parse on read");
		assert.deepEqual(parsed.options, PROBER_QUIZ.options);
	});

	it("boundary parity under Value.Convert: a NUMERIC correctAnswer parses (live-smoke lockout fix, 2026-09-26)", () => {
		// pi's boundary runs Value.Convert before Value.Check and the record
		// keeps the RAW args; a parse seam without Convert would reject what
		// the boundary accepted — the pending quiz renders nowhere = lockout.
		const numeric = {
			question: "What is 5 + 3 × 4?",
			options: [{ label: "17", value: "17" }, { label: "27", value: "27" }, { label: "9", value: "9" }],
			explanation: "Multiplication first.",
			correctAnswer: 17,
		};
		assert.equal(parseQuizInput(numeric)?.correctAnswer, "17", "converted to the string the boundary saw");
		assert.deepEqual(parseQuizInput({ ...numeric, multiSelect: true, correctAnswer: [17, "27"] })?.correctAnswer, ["17", "27"]);
	});

	it("garbage never parses: non-object, missing question, non-convertible or missing correctAnswer", () => {
		assert.equal(parseQuizInput("a string"), undefined);
		assert.equal(parseQuizInput({ options: [] }), undefined);
		assert.equal(parseQuizInput({ ...PROBER_QUIZ, correctAnswer: { bad: true } }), undefined);
		// Convert's widening (undefined → "") is caught by the boundary's refinement chain.
		assert.equal(parseQuizInput({ ...PROBER_QUIZ, correctAnswer: undefined }), undefined);
	});
});

describe("parseAskInput", () => {
	it("parses free-text and option modes; stringified invalid options do not parse", () => {
		assert.ok(parseAskInput({ question: "What do you want to learn?" }));
		assert.ok(parseAskInput({ question: "Which topics?", options: [{ label: "Physics" }, { label: "Logic" }], multiSelect: true }));
		assert.equal(parseAskInput({ question: "q", options: "[]" }), undefined);
	});
});

describe("parseProbeDoneInput", () => {
	it("boundary parity: the valid assessment parses", () => {
		assert.ok(Value.Check(probeDoneInputSchema, VALID_ASSESSMENT));
		const parsed = parseProbeDoneInput(VALID_ASSESSMENT);
		assert.ok(parsed);
		assert.equal(parsed.assessment.strands.length, 2);
	});

	it("the live crash shape (assessment STRINGIFIED) and a mid-stream partial do not parse", () => {
		// The exact double-encoding from the modal-realism run: strands died
		// on `.map` because the card cast the shape. The parse kills the class.
		assert.equal(parseProbeDoneInput({ assessment: JSON.stringify(VALID_ASSESSMENT.assessment) }), undefined);
		assert.equal(parseProbeDoneInput(JSON.stringify(VALID_ASSESSMENT.assessment).slice(0, 30)), undefined);
		assert.equal(parseProbeDoneInput({ assessment: { summary: "…" } }), undefined);
	});
});

describe("LaTeX-escape restoration (the JSON-debris fix, owner ruling 2026-09-26)", () => {
	// The exact live shapes from the modal-logic session: single-backslash
	// LaTeX inside JSON args — JSON escape resolution ate the command's
	// first letter (\f → FF ate 'f' of \forall, \v → VT ate 'v' of \varphi).
	it("presentation restores debris from parsed source fields (question + options + explanation)", () => {
		const parsed = parseQuizInput({
			question: "What does \\(\\forall x\\, \\varphi(x)\\) mean?",
			options: [
				{ label: "\\(\x0barphi\\) is true when every element satisfies it", value: "tarski" },
				{ label: "$\x0corall$ and \\(\\exists\\) are just shorthand", value: "shorthand" },
			],
			correctAnswer: "tarski",
			explanation: "Here $p\to q$ is an implication.",
		});
		assert.ok(parsed);
		assert.equal(parsed.question, "What does \\(\\forall x\\, \\varphi(x)\\) mean?");
		assert.equal(repairMathForDisplay(parsed.options[0]!.label), "\\(\\varphi\\) is true when every element satisfies it");
		assert.equal(repairMathForDisplay(parsed.options[1]!.label), "$\\forall$ and \\(\\exists\\) are just shorthand");
		assert.equal(repairMathForDisplay(parsed.explanation), "Here $p\\to q$ is an implication.");
	});

	it("control chars outside math spans and unbalanced delimiters pass through untouched", () => {
		assert.equal(quizQuestion("Pick:\ta\x0bb"), "Pick:\ta\x0bb");
		assert.equal(quizQuestion("\\(\\x0corall"), "\\(\\x0corall");
	});

	it("display math keeps real newlines (Option A, 2026-09-27); inline spans and non-newline debris restore", () => {
		const multiline = "Compare:\n\\[\n\\forall x, & f(x) = x^2 \\\\\n& g(x) = x^3\n\\]";
		assert.equal(quizQuestion(multiline), multiline);
		// sloppy \neq in display math stays broken — the accepted cost
		assert.equal(quizQuestion("Is \\[p \neq q\\] valid?"), "Is \\[p \neq q\\] valid?");
		assert.equal(repairMathForDisplay(quizQuestion("Is \\(p \neq q\\) valid?")!), "Is \\(p \\neq q\\) valid?");
		assert.equal(repairMathForDisplay(quizQuestion("Is \\(p\to q\\) valid?")!), "Is \\(p\\to q\\) valid?");
		assert.equal(repairMathForDisplay(quizQuestion("Evaluate \\[\\left( a \right)\\] carefully.")!), "Evaluate \\[\\left( a \\right)\\] carefully.");
	});

	it("shares recovery with ask and free-recall fields", () => {
		const ask = parseAskInput({ question: "Goal?", options: [{ label: "$\x0corall$ rigor" }, { label: "Intuition" }] });
		assert.ok(ask);
		assert.equal(repairMathForDisplay(ask.options![0]!.label), "$\\forall$ rigor");
		const explain = parseExplainInput({ question: "Explain $p\to q$", correctAnswer: "$p\neq q$ is different." });
		assert.ok(explain);
		assert.equal(repairMathForDisplay(explain.question), "Explain $p\\to q$");
		assert.equal(repairMathForDisplay(explain.correctAnswer), "$p\\neq q$ is different.");
	});
});

describe("restoreMathEscapes — dollar-delimiter rules", () => {
	it("keeps the same six-character inline recovery map", () => {
		for (const [debris, command] of [
			["\beta", "\\beta"], ["\to", "\\to"], ["\neq", "\\neq"],
			["\x0barphi", "\\varphi"], ["\x0corall", "\\forall"], ["\rho", "\\rho"],
		]) {
			assert.equal(restoreMathEscapes(`$${debris}$`), `$${command}$`);
		}
	});

	it("restores five display debris characters but keeps newline ambiguity and row breaks unchanged", () => {
		for (const [debris, command] of [
			["\beta", "\\beta"], ["\to", "\\to"], ["\x0barphi", "\\varphi"],
			["\x0corall", "\\forall"], ["\\left(x \right)", "\\left(x \\right)"],
		]) {
			assert.equal(restoreMathEscapes(`Compare:\n$$\n${debris}, p \neq q\n$$`), `Compare:\n$$\n${command}, p \neq q\n$$`);
		}
		const rows = "Compare:\n$$\n\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}\n$$";
		assert.equal(restoreMathEscapes(rows), rows);
	});

	it("restores all debris in one pass consistently across delimiter syntaxes", () => {
		const body = "p\to q, \rho";
		const legacy = restoreMathEscapes(`\\(${body}\\)`).slice(2, -2);
		assert.equal(restoreMathEscapes(`$${body}$`), `$${legacy}$`);
		assert.equal(legacy, "p\\to q, \\rho", "recovery converges instead of requiring a second render");
	});

	it("leaves non-math debris, escaped dollars, code, unbalanced runs, over-escaping and legacy spans untouched", () => {
		const prose = "Pasted:\t\x0cb. \\$\x0corall x$. A good $x$.";
		assert.equal(restoreMathEscapes(prose), prose);
		const code = "Literal `$\x0corall x$`.\n\n```text\n$\x0barphi$\n```\n\nReal $\x0corall x$.";
		assert.equal(restoreMathEscapes(code), code.replace("Real $\x0corall x$", "Real $\\forall x$"));
		for (const text of ["$\x0corall", "$$\n\x0corall x\n", "$\x0corall$$", "$$\x0corall$", "$$\n\\\\Omega\n$$", "\\[\np $a\neq b$\n\\]"]) {
			assert.equal(restoreMathEscapes(text), text);
		}
	});

	it("recognizes native inline runs and longer display closing fences", () => {
		assert.equal(restoreMathEscapes("Inline $$p\neq q$$."), "Inline $$p\\neq q$$.");
		assert.equal(restoreMathEscapes("$$\n\x0corall x\n$$$"), "$$\n\\forall x\n$$$");
	});
});

describe("parseExplainInput: the dock's display seam for explain calls", () => {
	const good = {
		question: "Explain why Mercury is hard to observe.",
		correctAnswer: "Its small angular separation from the Sun.",
		nodeId: "planet-order", // the teacher's field — STRIPPED by Clean, like quiz
		details: "Think about where it appears at dusk.",
	};

	it("parses a valid call and strips the teacher-only nodeId", () => {
		const parsed = parseExplainInput(good)!;
		assert.equal(parsed.correctAnswer, good.correctAnswer);
		assert.equal(parsed.details, good.details);
		assert.ok(!("nodeId" in parsed), "the teacher-only key is cleaned away");
	});

	it("an empty commitment or wrong shape never arms the dock (numeric strings DO coerce)", () => {
		assert.equal(parseExplainInput({ ...good, correctAnswer: "  " }), undefined);
		assert.equal(parseExplainInput("just a string"), undefined);
		assert.equal(parseExplainInput({ explanation: "e", correctAnswer: "a" }), undefined, "missing question");
		assert.equal(parseExplainInput({ question: "q", explanation: "e", correctAnswer: { nested: true } }), undefined);
		assert.equal(parseExplainInput({ question: "q", explanation: "e", correctAnswer: 42 })?.correctAnswer, "42");
	});
});

describe("over-escaped command recovery after shape parsing", () => {
	// Recover only for presentation: parsed source also builds durable
	// answers and identities, so shape parsing retains it byte-for-byte.
	const CLEAN =
		"Let $f : \\mathbb{R}^n \\to \\mathbb{R}$ be differentiable at $x$, with $\\nabla f(x) \\neq 0$. Among all unit directions $\\|u\\|_2 = 1$, which makes $D_u f(x)$ most negative?";
	const DOUBLE = (s: string): string => s.replace(/\\/g, "\\\\");
	const BASE = {
		options: [
			{ label: "$u^\\star = -\\nabla f(x)$", value: "neg" },
			{ label: "$u^\\star = \\nabla f(x)$", value: "pos" },
		],
		correctAnswer: "neg",
		explanation: "By Cauchy\u2013Schwarz: $$u^\\star = -\\frac{\\nabla f(x)}{\\|\\nabla f(x)\\|_2}$$",
	};

	it("presentation heals doubled and quadrupled questions; clean records and matrix row breaks pass through", () => {
		const matrix = "Which matrix matches? $$\\begin{pmatrix} 1 \\ 2 \\\\ 3 \\ 4\\end{pmatrix}$$";
		assert.equal(parseQuizInput({ ...BASE, question: matrix })?.question, matrix);
		for (const [question, shown] of [[DOUBLE(CLEAN), CLEAN], [DOUBLE(DOUBLE(CLEAN)), CLEAN], [CLEAN, CLEAN]]) {
			const parsed = parseQuizInput({ ...BASE, question });
			assert.ok(parsed, "parses");
			assert.equal(parsed.question, question, "shape parsing retains source");
			assert.equal(repairMathForDisplay(parsed.question), shown);
			assert.equal(parsed.explanation, BASE.explanation, "clean sibling fields stay byte-identical");
		}
	});

	it("doubled option labels and explanations heal too (the inference-runtime msg-7 shape)", () => {
		const parsed = parseQuizInput({
			question: "Let $A \\in \\mathbb{R}^{m \\times k}$ and $C = AB$.",
			options: [
				{ label: DOUBLE("$mkn$"), value: "mkn" },
				{ label: DOUBLE("$2mkn$"), value: "2" },
			],
			correctAnswer: "mkn",
			explanation: DOUBLE("$$c_{ij} = \\sum_{\\ell=1}^{k} a_{i\\ell}\\, b_{\\ell j}$$"),
		});
		assert.ok(parsed, "parses");
		assert.equal(parsed.options[0]!.label, "$mkn$");
		assert.equal(repairMathForDisplay(parsed.explanation), "$$c_{ij} = \\sum_{\\ell=1}^{k} a_{i\\ell}\\, b_{\\ell j}$$");
	});
});
