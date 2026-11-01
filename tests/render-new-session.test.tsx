import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import { clearOpeningPrompt, readOpeningPrompt, OPENING_PROMPT_FAILURE } from "../components/opening-prompt.ts";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
beforeEach(() => {
	const data = new Map<string, string>();
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => { data.set(key, value); },
		removeItem: (key: string) => { data.delete(key); },
	} });
});
afterEach(() => {
	if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "sessionStorage");
});

/** The sessionless draft (/chat/new): nothing is created until the first
 *  message is sent, and that message becomes the session's title. */

/** A fetch double: records calls, answers /api/chats with a canned id. */
function fakeFetch(id: string) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const f = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
		return new Response(JSON.stringify({ id }), { status: 200 });
	}) as typeof fetch;
	return { f, calls };
}

describe("startDraftSession — the create-on-send contract", () => {
	it("one POST /api/chats titled with the first message; returns the chat path", async () => {
		const { f, calls } = fakeFetch("c_new");
		assert.equal(await startDraftSession("teach me orbital mechanics", f), "/chat/c_new");
		assert.deepEqual(calls, [{ url: "/api/chats", method: "POST", body: { title: "teach me orbital mechanics" } }]);
	});

	it("the body carries kind and picks only when they apply", async () => {
		const pick = { id: "n_1", name: "Parity", statement: "Odd + odd = even." };
		const cases: Array<[string, "practice" | undefined, (typeof pick)[] | undefined, unknown]> = [
			["orbital mechanics", undefined, undefined, { title: "orbital mechanics" }],
			["the parity chain", "practice", undefined, { title: "the parity chain", kind: "practice" }],
			["free practice", "practice", [], { title: "free practice", kind: "practice" }],
			["drill me", "practice", [pick], { title: "drill me", kind: "practice", graphContext: { propositions: [pick] } }],
		];
		for (const [text, mode, picks, body] of cases) {
			const { f, calls } = fakeFetch("c9");
			await startDraftSession(text, f, mode, picks);
			assert.deepEqual(calls[0]!.body, body);
		}
	});

	it("a long opening text stays out of the URL and is stashed for the chat page", async () => {
		const { f } = fakeFetch("c_long");
		const text = `${"B2 First grammar item. ".repeat(1500)}end`;
		assert.equal(await startDraftSession(text, f), "/chat/c_long");
		assert.equal(readOpeningPrompt("c_long"), text);
		clearOpeningPrompt("c_long");
		assert.equal(readOpeningPrompt("c_long"), undefined);
	});

	it("empty or whitespace text never creates anything", async () => {
		const { f, calls } = fakeFetch("never");
		assert.equal(await startDraftSession("", f), null);
		assert.equal(await startDraftSession("   ", f), null);
		assert.equal(calls.length, 0);
	});
});

describe("DraftShell — the sessionless surface", () => {
	it("storage failure leaves the full draft editable beside the error", () => {
		const html = renderToStaticMarkup(<DraftShell busy={false} text="keep all my text" onChange={() => {}} onSend={() => {}} startError />);
		assert.ok(html.includes('role="alert"'));
		assert.ok(html.includes(OPENING_PROMPT_FAILURE));
		assert.match(html, /<div[^>]*role="textbox"[^>]*contentEditable="true"[^>]*>keep all my text<\/div>/);
	});

	it("practice picks show their count; teach mode with nothing picked shows no pick chip", () => {
		const picked = renderToStaticMarkup(
			<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="practice" picks={[{ id: "n_1", name: "Parity", statement: "Odd + odd = even." }]} />,
		);
		assert.match(picked, /1 node selected/);
		const teach = renderToStaticMarkup(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="teach" />);
		assert.ok(!teach.includes('data-testid="practice-props-chip"'));
	});
});
