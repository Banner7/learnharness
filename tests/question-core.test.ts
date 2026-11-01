import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
	askInputSchema,
	askOptionProblems,
	buildAnswer,
	compactAnswerForModel,
	dismissedAnswer,
	coerceCorrectAnswer,
	isCorrect,
	normalizeOptions,
	quizInputProblems,
	explainInputProblems,
	quizInputSchema,
	probeQuizInputSchema,
	quizDisplayInputSchema,
	resolveCorrect,
	toggleOption,
	toggleOther,
	emptyDockSelection,
	shuffleOptions,
	type QuestionData,
	toClientQuestion,
} from "../src/core/question-core.ts";
import { parseQuizInput } from "../src/core/tool-parts.ts";

// Schema-valid ⇔ gradeable: structural TypeBox check AND zero authoring problems.
const boundaryOk = (schema: TSchema, input: unknown, problems: string[]): boolean =>
	Value.Check(schema, input) && problems.length === 0;

describe("quizInputSchema / quizInputProblems (the authoring contract)", () => {
	const valid = {
		question: "Which planet is closest to the Sun?",
		options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
		correctAnswer: "Mercury",
		explanation: "Mercury is the innermost planet.",
		type: "check",
		nodeId: "planet-order",
	};

	it("accepts single-select labels and multi-select arrays (incl. JSON-stringified)", () => {
		assert.equal(boundaryOk(quizInputSchema, valid, quizInputProblems(valid)), true);
		const multi = {
			...valid,
			options: [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }],
			correctAnswer: ["a", "b"],
			multiSelect: true,
		};
		assert.equal(boundaryOk(quizInputSchema, multi, quizInputProblems(multi)), true);
		const stringified = { ...multi, correctAnswer: JSON.stringify(multi.correctAnswer) };
		assert.equal(boundaryOk(quizInputSchema, stringified, quizInputProblems(stringified)), true);
	});

	it("rejects ungradeable inputs; an unmatched slug lists the valid values for the retry", () => {
		const cases: [Parameters<typeof quizInputProblems>[0], RegExp][] = [
			[{ ...valid, correctAnswer: "mercury-planet" }, /does not match any option value.*"Mercury"/s],
			[{ ...valid, correctAnswer: ["Venus", "Mercury"] }, /multiSelect/],
			[{ ...valid, options: [{ label: "Mercury", value: "same" }, { label: "Venus", value: "same" }] }, /same value/],
			[{ ...valid, options: [{ label: "  " }, { label: "Mercury" }, { label: "Mars" }] }, /label is empty/],
			[{ ...valid, correctAnswer: "" }, /required/],
			[{ ...valid, correctAnswer: "[]" }, /./],
		];
		for (const [bad, problem] of cases) {
			assert.equal(boundaryOk(quizInputSchema, bad, quizInputProblems(bad)), false);
			assert.match(quizInputProblems(bad).join(" "), problem);
		}
	});
});

describe("askInputSchema / askOptionProblems", () => {
	it("accepts a valid ask; rejects duplicate values and empty labels (they break the dock's keying)", () => {
		const ask = { question: "Which topic first?", options: [{ label: "Limits" }, { label: "Chain rule" }] };
		assert.equal(boundaryOk(askInputSchema, ask, askOptionProblems(ask.options)), true);
		assert.match(askOptionProblems([{ label: "A", value: "x" }, { label: "B", value: "x" }]).join(" "), /same value/);
		assert.match(askOptionProblems([{ label: "" }, { label: "B" }]).join(" "), /label is empty/);
	});
});

describe("normalizeOptions", () => {
	it("trims, defaults value to label, drops empty labels, rejects duplicates, coerces JSON strings", () => {
		assert.deepEqual(normalizeOptions([{ label: "  Mercury  " }, { label: "Venus", value: " v " }, { label: "" }]).map((o) => o.value), ["Mercury", "v"]);
		assert.throws(() => normalizeOptions([{ label: "a", value: "x" }, { label: "b", value: "x" }]), /duplicate/);
		assert.deepEqual(normalizeOptions(JSON.stringify([{ label: "Slope", value: "slope" }])).map((o) => o.value), ["slope"]);
		assert.deepEqual(normalizeOptions("not json"), []);
	});
});

describe("shuffleOptions", () => {
	it("permutes without adding, removing, or mutating options", () => {
		const input = Array.from({ length: 20 }, (_, i) => ({ label: `o${i}`, value: `o${i}` }));
		const shuffled = shuffleOptions(input);
		assert.deepEqual([...shuffled].sort((a, b) => Number(a.label.slice(1)) - Number(b.label.slice(1))), input);
		assert.notEqual(input, shuffled); // a copy
	});
});

describe("resolveCorrect", () => {
	const options = normalizeOptions([
		{ label: "Mercury", value: "mercury" },
		{ label: "Venus", value: "venus" },
		{ label: "Earth", value: "earth" },
	]);

	it("resolves values to 1-based display indices, deduped and sorted", () => {
		assert.deepEqual(resolveCorrect("venus", options), { indices: [2] });
		assert.deepEqual(resolveCorrect(["earth", "mercury", "mercury"], options), { indices: [1, 3] });
	});

	it("errors on an unmatched or missing value", () => {
		assert.match(resolveCorrect("mars", options).error ?? "", /does not match any option value/);
		assert.ok(resolveCorrect(undefined, options).error);
	});
});

describe("exact answer membership precedes debris cleanup", () => {
	it("the calculus label's final period survives boundary, display, shuffle, and grading", () => {
		const correct = "$f$ need not be differentiable at $a$.";
		const input = {
			question: "All partial derivatives of $f$ exist at $a$. Must $f$ be differentiable there?",
			options: [{ label: "$f$ is differentiable at $a$." }, { label: correct }],
			explanation: "Existing partial derivatives need not give a linear approximation.",
			correctAnswer: correct,
		};
		const before = JSON.stringify(input);
		assert.ok(boundaryOk(probeQuizInputSchema, input, quizInputProblems(input)));
		const parsed = parseQuizInput(input);
		assert.ok(parsed, "the accepted raw call must also render");
		assert.equal(parsed.correctAnswer, correct);
		const options = normalizeOptions(parsed.options).reverse();
		const resolved = resolveCorrect(parsed.correctAnswer, options);
		assert.deepEqual(resolved, { indices: [1] });
		const qd: QuestionData = {
			id: "calculus-period",
			kind: "quiz",
			question: parsed.question,
			mode: "single-select",
			options,
			correctIndices: resolved.indices,
			explanation: parsed.explanation,
			createdAt: "2026-10-12T00:00:00Z",
		};
		assert.equal(buildAnswer(qd, { values: [correct] }).correct, true);
		assert.equal(buildAnswer(qd, { values: [input.options[0]!.label] }).correct, false);
		assert.equal(JSON.stringify(input), before, "raw arguments are never rewritten");
	});

	it("retains punctuation, quotes, colons, backticks and JSON-looking text in exact labels and explicit keys", () => {
		for (const key of ["value.", "value:", '"value"', "'value'", "`value`", ":value", '["a", "b"]']) {
			for (const option of [{ label: key }, { label: "A claim", value: key }]) {
				const input = {
					question: "Which claim?",
					options: [option, { label: "Other", value: "other" }],
					explanation: "The first claim follows.",
					correctAnswer: key,
				};
				assert.deepEqual(quizInputProblems(input), [], key);
				assert.ok(parseQuizInput(input), key);
				assert.deepEqual(resolveCorrect(key, normalizeOptions(input.options)), { indices: [1] }, key);
			}
		}
	});

	it("preserves exact multi-select entries while still healing non-matching copy debris", () => {
		const input = {
			question: "Which claims?",
			options: [{ label: "First." }, { label: "Second", value: "second" }],
			explanation: "Both claims follow.",
			multiSelect: true,
		};
		for (const correctAnswer of [["First.", ': "second"'], JSON.stringify(["First.", ': "second"'])]) {
			assert.deepEqual(quizInputProblems({ ...input, correctAnswer }), []);
			assert.ok(parseQuizInput({ ...input, correctAnswer }));
			assert.deepEqual(resolveCorrect(correctAnswer, normalizeOptions(input.options)), { indices: [1, 2] });
		}
	});
});

describe("isCorrect (exact-set match)", () => {
	it("matches identical sets regardless of order; rejects partial, extra, wrong, and empty", () => {
		assert.ok(isCorrect([3, 1], [1, 3]));
		for (const picked of [[1], [1, 2, 3], [1, 2], []]) assert.ok(!isCorrect(picked, [1, 3]), JSON.stringify(picked));
	});
});

function quizData(overrides?: Partial<QuestionData>): QuestionData {
	return {
		id: "q_test",
		kind: "quiz",
		question: "Which planet is closest to the Sun?",
		mode: "single-select",
		options: normalizeOptions([
			{ label: "Mercury", value: "mercury" },
			{ label: "Venus", value: "venus" },
		]),
		correctIndices: [1],
		explanation: "Mercury orbits closest.",
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("buildAnswer", () => {
	it("grades correct and wrong selections, ignoring unknown option values", () => {
		const ad = buildAnswer(quizData(), { values: ["mars", "mercury"] });
		assert.equal(ad.correct, true);
		assert.deepEqual(ad.answers.map((a) => [a.value, a.label, a.index]), [["mercury", "Mercury", 1]]);
		assert.equal(buildAnswer(quizData(), { values: ["venus"] }).correct, false);
		const dontKnow = buildAnswer(quizData(), { dontKnow: true });
		assert.deepEqual([dontKnow.correct, dontKnow.dontKnow, dontKnow.answers], [false, true, []]);
	});

	it("carries clamped confidence on quiz answers only; ask is never graded", () => {
		assert.equal(buildAnswer(quizData(), { values: ["mercury"], confidence: 90 }).confidence, 90);
		assert.equal(buildAnswer(quizData(), { values: ["mercury"], confidence: 150 }).confidence, 100);
		assert.equal(buildAnswer(quizData(), { values: ["mercury"], confidence: -5 }).confidence, 0);
		assert.equal(buildAnswer(quizData(), { values: ["mercury"] }).confidence, undefined);
		assert.equal(buildAnswer(quizData(), { dontKnow: true, confidence: 70 }).confidence, undefined);
		const ask = quizData({ kind: "ask", correctIndices: undefined, explanation: undefined });
		assert.equal(buildAnswer(ask, { other: "x", confidence: 70 }).confidence, undefined);
		assert.equal(buildAnswer(ask, { values: ["mercury"] }).correct, undefined);
	});
});

describe("compactAnswerForModel (the model-visible diet)", () => {
	it("quiz: the learner's selection, verdict, confidence, note — NOTHING the model authored", () => {
		const compact = compactAnswerForModel(buildAnswer(quizData(), { values: ["mercury"], confidence: 70, thinking: "guessed" }));
		assert.deepEqual(compact, {
			kind: "quiz",
			answers: [{ index: 1, label: "Mercury" }],
			correct: true,
			confidence: 70,
			thinking: "guessed",
		});
	});

	it("dontKnow stands alone; ask carries its text", () => {
		assert.deepEqual(compactAnswerForModel(buildAnswer(quizData(), { dontKnow: true })), { kind: "quiz", dontKnow: true });
		const askQD: QuestionData = { ...quizData(), kind: "ask", mode: "text", correctIndices: undefined, explanation: undefined };
		assert.deepEqual(compactAnswerForModel(buildAnswer(askQD, { text: "lateral thinking" })), { kind: "ask", text: "lateral thinking" });
	});
});

describe("dismissedAnswer (the ESC-abort record)", () => {
	it("the minimum honest answer, compacting to the one-field model diet", () => {
		const ad = dismissedAnswer("ask", "What drives you?");
		assert.deepEqual([ad.dismissed, ad.dontKnow, ad.answers], [true, false, []]); // a skip is not a gap claim
		assert.deepEqual(compactAnswerForModel(dismissedAnswer("quiz", "Pick one")), { kind: "quiz", dismissed: true });
	});
});

describe("toClientQuestion", () => {
	it("NEVER exposes correctIndices or explanation", () => {
		const raw = JSON.stringify(toClientQuestion(quizData()));
		assert.ok(!raw.includes("correctIndices") && !raw.includes("Mercury orbits closest"));
	});
});

describe("dock selection (toggleOption / toggleOther)", () => {
	it("multi-select: options and Other coexist — neither clears the other", () => {
		let sel = emptyDockSelection();
		sel = toggleOption("multi-select", sel, 0);
		sel = toggleOption("multi-select", sel, 1);
		sel = toggleOther("multi-select", sel);
		assert.deepEqual([...sel.selected], [0, 1], "Other never clears picked options");
		assert.equal(sel.otherSelected, true);
		sel = toggleOption("multi-select", sel, 2);
		assert.equal(sel.otherSelected, true, "options never clear a typed custom answer");
		sel = toggleOption("multi-select", sel, 0);
		sel = toggleOther("multi-select", sel);
		assert.equal(sel.otherSelected, false);
		assert.deepEqual([...sel.selected], [1, 2]);
	});
});

describe("explain: free-recall quizzing", () => {
	const explainQD: QuestionData = {
		id: "e1",
		kind: "explain",
		question: "Why does the Michelson-Morley null result matter?",
		mode: "text",
		options: [],
		committedAnswer: "It ruled out the luminiferous aether.",
		createdAt: new Date().toISOString(),
	};

	it("an empty commitment is the one authoring problem", () => {
		assert.deepEqual(explainInputProblems({ correctAnswer: "Full speed is c." }), []);
		assert.match(explainInputProblems({ correctAnswer: "   " }).join(" "), /correctAnswer is required/);
	});

	it("snapshots the commitment, never grades free text, and never leaks the commitment to the model", () => {
		const ad = buildAnswer(explainQD, { text: "No idea about aether." });
		assert.equal(ad.correct, undefined, "no client verdict — the model grades in its reply");
		assert.equal(ad.committed, "It ruled out the luminiferous aether.");
		const compact = compactAnswerForModel(ad);
		assert.equal(compact.text, "No idea about aether.");
		assert.ok(!JSON.stringify(compact).includes("luminiferous"), "the commitment must not ride the result");
	});
});

describe("the quiz role field (predict | check)", () => {
	const valid = {
		question: "Which planet is closest to the Sun?",
		options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
		correctAnswer: "Mercury",
		explanation: "Mercury is the innermost planet.",
		type: "check",
		nodeId: "planet-order",
	};
	it("the teach schema REQUIRES type; the display parse keeps it", () => {
		assert.equal(Value.Check(quizInputSchema, valid), true);
		assert.equal(Value.Check(quizInputSchema, { ...valid, type: undefined }), false);
		const cleaned = Value.Clean(quizDisplayInputSchema, { ...valid }) as Record<string, unknown>;
		assert.equal(cleaned.type, "check");
	});

	it("buildAnswer snapshots the role and carries both trimmed thinking channels; empty channels stay absent", () => {
		const a = buildAnswer({ ...quizData(), questionType: "predict" }, { values: ["mercury"], thinking: "  guessed  ", readingThinking: "  reading note  " });
		assert.deepEqual([a.questionType, a.thinking, a.readingThinking], ["predict", "guessed", "reading note"]);
		const b = buildAnswer(quizData(), { values: ["mercury"], thinking: "  " });
		assert.deepEqual([b.questionType, b.thinking, b.readingThinking], [undefined, undefined, undefined]);
	});

	it("compactAnswerForModel: distinct keys for the two channels; legacy `note` folds into thinking", () => {
		const a = buildAnswer(quizData(), { values: ["mercury"], thinking: "h", readingThinking: "r" });
		const compact = compactAnswerForModel(a) as Record<string, unknown>;
		assert.deepEqual([compact.thinking, compact.thinkingWhileReading], ["h", "r"]);
		const legacy = compactAnswerForModel({ ...a, thinking: undefined, note: "old note" }) as Record<string, unknown>;
		assert.equal(legacy.thinking, "old note", "records written before the rename still reach the model");
		assert.equal("note" in legacy, false);
	});
});
