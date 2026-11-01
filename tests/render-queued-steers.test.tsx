/**
 * The visibleQueuedSteers fold (composer steering, owner arc 2026-10-03):
 * which queued steers still show above the composer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleQueuedSteers } from "../components/session-core.ts";

describe("visibleQueuedSteers (the fold: a line dies when its card lands)", () => {
	it("a queued steer stays visible until its id lands in the messages", () => {
		const queue = [
			{ id: "steer_a", text: "a" },
			{ id: "steer_b", text: "b" },
		];
		const before = visibleQueuedSteers(queue, [{ id: "msg_1" } as never]);
		assert.equal(before.length, 2, "nothing landed yet — both lines show");
		const after = visibleQueuedSteers(queue, [
			{ id: "msg_1" } as never,
			{ id: "steer_a", role: "user", content: "a" } as never,
		]);
		assert.deepEqual(after.map((s) => s.id), ["steer_b"], "the drained steer's line dropped");
	});
});
