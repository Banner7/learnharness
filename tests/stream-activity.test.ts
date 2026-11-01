/**
 * streamingToolActivity: a tool part stays input-streaming for its WHOLE
 * execution, so the activity line must name the tool actually running, not a
 * generic "Writing a question…" over minutes-long greps.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhViewMessage } from "../src/core/view.ts";
import { streamingToolActivity } from "../src/core/pending.ts";

function msg(role: string, parts: unknown[]): LhViewMessage {
	return { id: "m1", role, parts } as unknown as LhViewMessage;
}

function toolPart(tool: string, state: string) {
	return { type: `tool-${tool}`, toolCallId: "c1", state, input: {} };
}

describe("streamingToolActivity (the turn-activity label)", () => {
	it("question tools, local tools, and unknown tools each get distinct labels", () => {
		const label = (tool: string) => streamingToolActivity([msg("assistant", [toolPart(tool, "input-streaming")])]);
		assert.equal(label("quiz"), label("ask_user_question"));
		assert.notEqual(label("grep"), label("quiz"));
		assert.notEqual(label("read"), label("grep"));
		assert.equal(label("mystery_tool"), "Working…");
	});

	it("no activity once the call settles or the turn ends; a later live part wins over a settled one", () => {
		assert.equal(streamingToolActivity([msg("assistant", [toolPart("grep", "output-available")])]), null);
		assert.equal(streamingToolActivity([msg("user", [{ type: "text", text: "hi" }])]), null);
		assert.equal(streamingToolActivity([]), null);
		const parts = [toolPart("read", "output-available"), toolPart("grep", "input-streaming")];
		assert.equal(
			streamingToolActivity([msg("assistant", parts)]),
			streamingToolActivity([msg("assistant", [toolPart("grep", "input-streaming")])]),
		);
	});
});
