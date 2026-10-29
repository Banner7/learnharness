import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeCodeModelNames } from "../src/agent/claude-code/model-names.ts";

// A Claude Code 2.1.312 `initialize` reply, trimmed to the fields the parser reads.
const CLI_2_1_312 = [
	{ value: "default", displayName: "Default (recommended)", description: "Sonnet 5.5 · Efficient for routine tasks" },
	{ value: "sonnet", displayName: "Sonnet", description: "Sonnet 5.5 · Efficient for routine tasks" },
	{ value: "fable", displayName: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks · Requires usage credits" },
	{ value: "opus", displayName: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks" },
	{ value: "haiku", displayName: "Haiku", description: "Haiku 5.5 · Fastest for quick answers" },
];

test("each alias gets the CLI's own name and version", () => {
	const names = parseClaudeCodeModelNames(CLI_2_1_312);
	assert.equal(names.get("opus"), "Opus 5.5");
	assert.equal(names.get("sonnet"), "Sonnet 5.5");
	assert.equal(names.get("haiku"), "Haiku 5.5");
});

test("a description that does not start with a name and version is skipped, not shown", () => {
	const names = parseClaudeCodeModelNames([
		{ value: "opus", description: "Best for everyday, complex tasks" },
		{ value: "sonnet", description: "Sonnet · Efficient" },
		{ value: "haiku", description: "" },
		{ value: 7, description: "Haiku 5.5 · Fastest" },
		null,
	]);
	assert.equal(names.size, 0);
	assert.equal(parseClaudeCodeModelNames(undefined).size, 0);
	assert.equal(parseClaudeCodeModelNames({ opus: "Opus 5.5" }).size, 0);
});
