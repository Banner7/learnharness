/**
 * Unit tests — question-core (pure logic, no server, no LLM).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
	askInputSchema,
	quizInputBase,
	askOptionProblems,
	buildAnswer,
	compactAnswerForModel,
	dismissedAnswer,
	coerceCorrectAnswer,
	isCorrect,
	normalizeOptions,
	quizInputProblems,
	explainInputBase,
	explainInputObject,
	explainInputProblems,
	quizInputSchema,
	probeQuizInputSchema,
	quizDisplayInputSchema,
	normalizeQuizType,
	resolveCorrect,
	toggleOption,
	toggleOther,
	emptyDockSelection,
	shuffleOptions,
	type QuestionData,
	toClientQuestion,
} from "../src/core/question-core.ts";
import { toolQuestionKind } from "../src/core/pending.ts";
import { parseQuizInput } from "../src/core/tool-parts.ts";

// ─── the authoring contract (TypeBox schemas + execute-time refinements) ──
// Schema-valid ⇔ gradeable: a quiz whose correctAnswer can't be resolved
// dies at the tool-call boundary (structural TypeBox check in pi's loop +
// the refinement problems in the tool's execute — a ToolInputError the
// model retries on), and never reaches the learner's dock. The boundary
// predicate is BOTH: structural check AND zero authoring problems.
const boundaryOk = (schema: TSchema, input: unknown, problems: string[]): boolean =>
	Value.Check(schema, input) && problems.length === 0;

const keysOf = (schema: unknown) => Object.keys((schema as { properties: Record<string, unknown> }).properties);

describe("the schema's argument order (models emit tool args in schema order)", () => {
	// Reasoning before the pick (owner, 2026-09-25); the teach schemas'
	// required pair (`type`, `nodeId`) LEADS because glm-5.3 dropped exactly
	// those fields when they trailed the long content fields (2026-10-09).
	it("quiz: explanation immediately before correctAnswer; explain: one authoring field", () => {
		assert.deepEqual(keysOf(quizInputSchema), ["type", "nodeId", "question", "options", "multiSelect", "explanation", "correctAnswer", "details"]);
		assert.deepEqual(keysOf(probeQuizInputSchema), ["question", "options", "multiSelect", "explanation", "correctAnswer", "details"]);
		assert.deepEqual(keysOf(explainInputBase), ["question", "correctAnswer", "details"]);
		assert.deepEqual(keysOf(explainInputObject), ["type", "nodeId", ...keysOf(explainInputBase)]);
	});
});

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
		// The union lists String first, so providers sometimes stringify arrays.
		const stringified = { ...multi, correctAnswer: JSON.stringify(multi.correctAnswer) };
		assert.equal(boundaryOk(quizInputSchema, stringified, quizInputProblems(stringified)), true);
	});

	it("rejects the observed failure: a correctAnswer slug matching no option value, listing the valid values", () => {
		const bad = {
			question: "What is Nietzsche's genealogical claim about religion?",
			options: [{ label: "A cultural diagnosis" }, { label: "Atheism as a conclusion" }],
			correctAnswer: "cultural-diagnosis",
			explanation: "...",
		};
		const problems = quizInputProblems(bad);
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, /does not match any option value/);
		assert.match(problems[0]!, /"A cultural diagnosis"/); // the valid values are listed for the retry
	});

	it("rejects ungradeable inputs", () => {
		const cases: [Parameters<typeof quizInputProblems>[0], RegExp][] = [
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
	it("trims labels, defaults value to label, drops empty labels", () => {
		assert.deepEqual(normalizeOptions([{ label: "  Mercury  " }, { label: "Venus", value: " v " }, { label: "" }]), [
			{ label: "Mercury", value: "Mercury", description: undefined },
			{ label: "Venus", value: "v", description: undefined },
		]);
		assert.deepEqual(normalizeOptions(undefined), []);
	});

	it("throws on duplicate values; coerces JSON-encoded option strings (GLM wobble)", () => {
		assert.throws(() => normalizeOptions([{ label: "a", value: "x" }, { label: "b", value: "x" }]), /duplicate/);
		const asString = JSON.stringify([{ label: "Slope", value: "slope" }, { label: "Value", value: "value" }]);
		assert.deepEqual(normalizeOptions(asString), [
			{ label: "Slope", value: "slope", description: undefined },
			{ label: "Value", value: "value", description: undefined },
		]);
		assert.deepEqual(normalizeOptions("not json"), []);
	});

	it("quiz options carry NO description field (it telegraphed correctness); ask keeps it", () => {
		const optionProps = (schema: { properties: { options: unknown } }) =>
			(schema.properties.options as { items: { properties: Record<string, unknown> } }).items.properties;
		assert.ok(!("description" in optionProps(quizInputBase)));
		assert.ok("description" in optionProps(askInputSchema));
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

describe("coerceCorrectAnswer", () => {
	it("wraps strings, passes arrays, parses JSON arrays, keeps exact keys that look like JSON", () => {
		const values = ["mercury", "a", "b"];
		assert.deepEqual(coerceCorrectAnswer("mercury", values), ["mercury"]);
		assert.deepEqual(coerceCorrectAnswer(["a", "b"], values), ["a", "b"]);
		assert.deepEqual(coerceCorrectAnswer('["a", "b"]', values), ["a", "b"]);
		assert.deepEqual(coerceCorrectAnswer("[not json", values), ["[not json"]);
		const key = '["a", "b"]';
		assert.deepEqual(coerceCorrectAnswer(key, [...values, key]), [key]);
		assert.deepEqual(coerceCorrectAnswer("[]", ["[]"]), ["[]"]);
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

	it("resolves against POST-shuffle order (indices track display)", () => {
		const shuffled = shuffleOptions(options);
		assert.deepEqual(resolveCorrect("earth", shuffled).indices, [shuffled.findIndex((o) => o.value === "earth") + 1]);
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

	it("never redirects an exact punctuated key to a different debris-free option", () => {
		const keys = ["value", "value.", '"value"', "`value`", ":value"];
		const options = normalizeOptions(keys.map((value, i) => ({ label: `Claim ${i}`, value })));
		for (const [i, key] of keys.entries()) {
			assert.deepEqual(resolveCorrect(key, options), { indices: [i + 1] }, key);
		}
		assert.deepEqual(options.map((o) => o.value), keys, "canonical keys stay distinct and untouched");
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
		assert.equal(ad.dontKnow, false);
		assert.equal(buildAnswer(quizData(), { values: ["venus"] }).correct, false);
	});

	it("dontKnow is never correct and records no answers", () => {
		const ad = buildAnswer(quizData(), { dontKnow: true });
		assert.equal(ad.correct, false);
		assert.equal(ad.dontKnow, true);
		assert.deepEqual(ad.answers, []);
	});

	it("keeps the note only when non-empty", () => {
		assert.equal(buildAnswer(quizData(), { values: ["mercury"], thinking: "  " }).thinking, undefined);
		assert.equal(buildAnswer(quizData(), { values: ["mercury"], thinking: " x " }).thinking, "x");
	});

	// Confidence (owner, 2026-10-01): the slider's raw probability rides on
	// real quiz answers only — never on "I don't know", never on ask/explain.
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

	it("multi-select grades as exact-set", () => {
		const multi = quizData({
			mode: "multi-select",
			options: normalizeOptions([{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }]),
			correctIndices: [1, 2],
		});
		assert.equal(buildAnswer(multi, { values: ["a", "b"] }).correct, true);
		assert.equal(buildAnswer(multi, { values: ["a"] }).correct, false);
		assert.equal(buildAnswer(multi, { values: ["a", "b", "c"] }).correct, false);
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
		assert.equal(ad.kind, "ask");
		assert.equal(ad.questionText, "What drives you?");
		assert.equal(ad.dismissed, true);
		assert.equal(ad.dontKnow, false); // a skip is not a gap claim
		assert.deepEqual(ad.answers, []);
		assert.deepEqual(compactAnswerForModel(dismissedAnswer("quiz", "Pick one")), { kind: "quiz", dismissed: true });
	});
});

describe("toolQuestionKind (tool→kind parity with the dock)", () => {
	it("the three question tools map; unknown tools fall to ask", () => {
		assert.equal(toolQuestionKind("quiz"), "quiz");
		assert.equal(toolQuestionKind("explain"), "explain");
		assert.equal(toolQuestionKind("ask_user_question"), "ask");
		assert.equal(toolQuestionKind("anything-else"), "ask");
	});
});

describe("toClientQuestion", () => {
	it("NEVER exposes correctIndices or explanation", () => {
		const cq = toClientQuestion(quizData());
		const raw = JSON.stringify(cq);
		assert.ok(!raw.includes("correctIndices"));
		assert.ok(!raw.includes("Mercury orbits closest"));
		assert.equal(cq.options.length, 2);
	});
});

// The live bug: in a multi-select ask, picking the custom "Other…" row
// cleared every already-picked option (single-select displacement logic
// applied to both modes).
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

	it("multi-select: any selection clears dont-know", () => {
		const dontKnow = { selected: new Set<number>(), otherSelected: false, dontKnow: true };
		assert.equal(toggleOption("multi-select", dontKnow, 0).dontKnow, false);
		assert.equal(toggleOther("multi-select", dontKnow).dontKnow, false);
	});

	it("single-select: displacement semantics are unchanged", () => {
		let sel = emptyDockSelection();
		sel = toggleOption("single-select", sel, 0);
		sel = toggleOther("single-select", sel);
		assert.deepEqual([...sel.selected], [], "Other displaces the picked option");
		assert.equal(sel.otherSelected, true);
		sel = toggleOption("single-select", sel, 1);
		assert.equal(sel.otherSelected, false, "an option displaces Other");
		assert.deepEqual([...sel.selected], [1]);
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

	it("snapshots the commitment; the client NEVER grades free text", () => {
		const ad = buildAnswer(explainQD, { text: "Something about light speed being constant?" });
		assert.equal(ad.correct, undefined, "no client verdict — the model grades in its reply");
		assert.equal(ad.committed, "It ruled out the luminiferous aether.");
		assert.equal(ad.text, "Something about light speed being constant?");
	});

	it("compactAnswerForModel (explain): the learner's words ONLY — never the model's own commitment", () => {
		const compact = compactAnswerForModel(buildAnswer(explainQD, { text: "No idea about aether." }));
		assert.equal(compact.text, "No idea about aether.");
		assert.equal(compact.kind, "explain");
		assert.ok(!JSON.stringify(compact).includes("luminiferous"), "the commitment must not ride the result");
		assert.ok(!("committed" in compact));
		assert.ok(!("questionText" in compact));
	});
});

// Teaching units are a predict → teach → check cycle. The teach quiz schema
// carries a REQUIRED `type` declaring the role; the prober's quiz never does.
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

	it("normalizeQuizType: exact literals only — old records and wobble degrade to check-style", () => {
		assert.equal(normalizeQuizType("predict"), "predict");
		assert.equal(normalizeQuizType("check"), "check");
		for (const wobble of [undefined, "prediction", 42]) assert.equal(normalizeQuizType(wobble), undefined);
	});

	function quizQd(): QuestionData {
		const options = normalizeOptions(valid.options);
		return {
			id: "q1",
			kind: "quiz",
			question: valid.question,
			mode: "single-select",
			options,
			correctIndices: resolveCorrect(valid.correctAnswer, options).indices,
			explanation: valid.explanation,
			createdAt: new Date().toISOString(),
		};
	}

	it("buildAnswer snapshots the question's role and carries both thinking channels", () => {
		const a = buildAnswer({ ...quizQd(), questionType: "predict" }, { values: ["Mercury"], thinking: "  guessed  ", readingThinking: "  reading note  " });
		assert.equal(a.questionType, "predict");
		assert.equal(a.thinking, "guessed");
		assert.equal(a.readingThinking, "reading note");
		const b = buildAnswer(quizQd(), { values: ["Mercury"] });
		assert.equal(b.thinking, undefined, "empty channels stay absent, never empty strings");
		assert.equal(b.readingThinking, undefined);
		assert.equal(b.questionType, undefined, "a role-less QuestionData (probe / old record) answers role-less");
	});

	it("compactAnswerForModel: distinct keys for the two channels; legacy `note` folds into thinking", () => {
		const a = buildAnswer(quizQd(), { values: ["Mercury"], thinking: "h", readingThinking: "r" });
		const compact = compactAnswerForModel(a) as Record<string, unknown>;
		assert.equal(compact.thinking, "h");
		assert.equal(compact.thinkingWhileReading, "r");
		const legacy = compactAnswerForModel({ ...a, thinking: undefined, note: "old note" }) as Record<string, unknown>;
		assert.equal(legacy.thinking, "old note", "records written before the rename still reach the model");
		assert.equal("note" in legacy, false, "the legacy key never re-crosses the wire");
	});
});
