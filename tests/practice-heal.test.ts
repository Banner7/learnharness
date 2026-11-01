/**
 * THE WEAK-MODEL ARGUMENT HEAL (owner, 2026-10-04 — the GLM practice-loop
 * incident): glm-5.3 sent `"mode": "\"recall\""` — a JSON-string-encoded
 * enum — on 19 consecutive `problem` calls, because TypeBox's error never
 * named the expected values. The heal runs at pi's prepareArguments seam
 * (BEFORE validation): string values where the schema expects a literal
 * union / boolean / null / number / array are JSON.parse-d and kept when
 * the parsed value satisfies the schema.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concludeInputObject, problemInputObject } from "../src/agent/tools/practice.ts";
import { healEncodedArguments } from "../src/core/argument-heal.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";

/** The incident's exact mode spelling: the string "recall" INCLUDING its quotes. */
const QUOTED = (s: string) => `"${s}"`;

describe("healEncodedArguments", () => {
	it("END-TO-END: the healed incident args pass pi-ai validation where the raw threw", () => {
		const raw = {
			statement: "Prove that every finite group of prime order is cyclic.",
			mode: QUOTED("recall"),
			target: ["group-order"],
			modelSolution: "Let |G| = p. Any x ≠ e generates a subgroup whose order divides p…",
		};
		const validate = (args: unknown) => validateToolArguments(
			{ name: "problem", parameters: problemInputObject } as never,
			{ id: "call_x", type: "toolCall", name: "problem", arguments: args } as never,
		);
		assert.throws(() => validate(raw));
		assert.equal((validate(healEncodedArguments(raw, problemInputObject)) as { mode: unknown }).mode, "recall");
	});

	it("heals encoded enums, null, booleans and arrays", () => {
		assert.deepEqual(
			healEncodedArguments({ outcome: QUOTED("solved"), rung: "null", retest: "true" }, concludeInputObject),
			{ outcome: "solved", rung: null, retest: true },
		);
		assert.deepEqual(healEncodedArguments({ rung: QUOTED("R2") }, concludeInputObject), { rung: "R2" });
		assert.deepEqual(healEncodedArguments({ target: '["a","b"]' }, problemInputObject), { target: ["a", "b"] });
	});

	it("well-formed args, plain string properties and non-objects pass through as the SAME reference", () => {
		const args = { mode: "recall", target: ["a"], retest: false };
		assert.equal(healEncodedArguments(args, problemInputObject), args);
		assert.equal(healEncodedArguments(args, concludeInputObject), args);
		const statement = { statement: '"not JSON-healed"' };
		assert.equal(healEncodedArguments(statement, problemInputObject), statement);
		const arr = [1, 2];
		assert.equal(healEncodedArguments(arr, problemInputObject), arr);
		assert.equal(healEncodedArguments(null, problemInputObject), null);
	});

	it("unhealable values stay — validation rejects them honestly", () => {
		assert.deepEqual(healEncodedArguments({ mode: QUOTED("bogus") }, problemInputObject), { mode: QUOTED("bogus") });
	});
});
