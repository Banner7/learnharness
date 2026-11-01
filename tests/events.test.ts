/**
 * THE EVENT BUS + NOTIFICATION CHANNEL (push-architecture slice 1,
 * 2026-10-02): the bus is typed and error-isolated; the SSE seam is one
 * connection per open window — frames in, cancel out, bus untouched.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emit, subscribe, type ServerEvent } from "../src/core/events.ts";
import { eventsResponse } from "../src/server/events-stream.ts";

const decode = (chunk: Uint8Array) => new TextDecoder().decode(chunk);

describe("event bus", () => {
	it("delivers typed events with their payload until unsubscribed", () => {
		const got: ServerEvent[] = [];
		const off = subscribe((e) => got.push(e));
		emit("turn-started", { chatId: "chat_a" });
		emit("activity-changed", {});
		off();
		emit("chats-changed", {});
		assert.deepEqual(got, [{ type: "turn-started", chatId: "chat_a" }, { type: "activity-changed" }]);
	});

	it("one listener throwing NEVER breaks the others (error isolation)", () => {
		const got: string[] = [];
		const bad = subscribe(() => {
			throw new Error("listener bug");
		});
		const off = subscribe((e) => got.push(e.type));
		emit("turn-settled", { chatId: "chat_b" });
		bad();
		off();
		assert.deepEqual(got, ["turn-settled"]);
	});

	it("an unsubscribe DURING emit is safe (snapshot iteration)", () => {
		const got: string[] = [];
		let off2: () => void = () => {};
		const off1 = subscribe(() => off2()); // listener 2 leaves mid-emit
		off2 = subscribe((e) => got.push(e.type));
		emit("chats-changed", {});
		off1();
		off2();
		assert.deepEqual(got, ["chats-changed"], "listener 2 still got THIS event (snapshot), no crash");
	});
});

describe("eventsResponse (the SSE seam)", () => {
	it("streams one parseable frame per event and stays open across settled events", async () => {
		const res = eventsResponse();
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("Content-Type"), "text/event-stream");
		assert.equal(res.headers.get("X-Accel-Buffering"), "no");
		const reader = res.body!.getReader();
		emit("turn-settled", { chatId: "chat_x" });
		assert.equal(decode((await reader.read()).value!), 'event: turn-settled\ndata: {"chatId":"chat_x"}\n\n');
		emit("chats-changed", {});
		const { value, done } = await reader.read();
		assert.equal(done, false, "the channel never self-closes — the client owns the lifetime");
		assert.match(decode(value!), /event: chats-changed/);
		await reader.cancel();
	});

	it("cancel() unsubscribes — later emits reach OTHER windows only", async () => {
		const r1 = eventsResponse().body!.getReader();
		const r2 = eventsResponse().body!.getReader();
		await r1.cancel();
		emit("turn-settled", { chatId: "chat_y" });
		assert.match(decode((await r2.read()).value!), /event: turn-settled/);
		assert.equal((await r1.read()).done, true, "the cancelled connection carries nothing further");
		await r2.cancel();
	});
});
