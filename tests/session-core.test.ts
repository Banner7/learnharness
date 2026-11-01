import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { absorbed, SessionModel } from "../components/session-core.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newUserMessage, newAnswerResult, newThinkingMessage, needsContinuation, endsInDismissal, pendingQuestionOf } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/index.ts";
import { buildAnswer, dismissedAnswer, type QuestionData } from "../src/core/question-core.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** SSE-frame each object the way the server's subscriber stream does. */
function sse(...events: unknown[]): string {
	return events.map((e) => (e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`)).join("");
}

/** A Response whose body drips `text` in `slice`-byte reads. */
function dripped(text: string, slice: number): Response {
	const bytes = new TextEncoder().encode(text);
	return new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < bytes.length; i += slice) controller.enqueue(bytes.slice(i, i + slice));
			controller.close();
		},
	}));
}

const sseResponse = (...events: unknown[]) => new Response(sse(...events));

/** A live body: each push() writes one SSE frame. */
function pushed(): { response: Response; push: (e: unknown) => void } {
	const enc = new TextEncoder();
	let push: (e: unknown) => void = () => {};
	const body = new ReadableStream<Uint8Array>({ start(c) { push = (e) => c.enqueue(enc.encode(sse(e))); } });
	return { response: new Response(body), push };
}

/** A body that writes each event batch in order, awaiting the gates between them. */
function gated(...parts: Array<unknown[] | Promise<void>>): Response {
	const enc = new TextEncoder();
	return new Response(new ReadableStream<Uint8Array>({
		async start(c) {
			for (const part of parts) {
				if (part instanceof Promise) await part;
				else c.enqueue(enc.encode(sse(...part)));
			}
			c.close();
		},
	}));
}

function dietFetch(opts: {
	stream: () => Response;
	userText?: string;
	record?: unknown[];
	post?: () => Response;
	onPost?: (body: string) => void;
}): typeof globalThis.fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/chat") {
			if (opts.onPost && typeof init?.body === "string") opts.onPost(init.body);
			return opts.post?.() ?? Response.json({ ok: true });
		}
		if (url === "/api/chats/chat_x") {
			const messages = opts.record ?? (opts.userText === undefined ? [] : [{ id: "u1", role: "user", content: opts.userText, timestamp: 1 }]);
			return Response.json({ messages });
		}
		if (url === "/api/chats/chat_x/stream") return opts.stream();
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
}

function assistantMsg(id: string, text: string): LhMessage {
	return {
		id, role: "assistant", content: [{ type: "text", text }], stopReason: "stop",
		usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 }, timestamp: 0, provider: "openrouter", model: "test",
	} as unknown as LhMessage;
}

function partial(blocks: unknown[]): Record<string, unknown> {
	return {
		type: "message_update",
		message: { role: "assistant", content: blocks, usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 }, provider: "openrouter", model: "test" },
		assistantMessageEvent: { type: "text", textDelta: "" },
	};
}

/** message_start + message_end of a plain text assistant reply. */
function reply(text: string): unknown[] {
	return [
		{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text }] } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } },
	];
}

function model(opts: Partial<ConstructorParameters<typeof SessionModel>[0]> = {}): SessionModel {
	return new SessionModel({ chatId: "chat_x", initialMessages: [], ...opts });
}

/** Route POST /api/chat to `chatPOST(n)` and /api/jobs polls to `jobsGET(n)`; returns the call log. */
function installFetch(routes: { chatPOST: (attempt: number) => Response; jobsGET?: (poll: number) => boolean }) {
	const calls: { url: string; body: string | undefined }[] = [];
	let poll = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, body: init?.body as string | undefined });
		if (url === "/api/chat" && init?.method === "POST") return routes.chatPOST(calls.filter((c) => c.url === "/api/chat").length);
		if (url.startsWith("/api/jobs")) return Response.json({ turnInFlight: routes.jobsGET?.(++poll) ?? false });
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
	return calls;
}

describe("postInputEvent (the 409 identity-retry)", { skip: process.env.NO_SLOW ? true : undefined }, () => {
	it("the default fetch is receiver-safe (browser 'Illegal invocation')", async () => {
		globalThis.fetch = (function (this: unknown) {
			if (this !== globalThis) throw new TypeError("Illegal invocation");
			return Promise.resolve(sseResponse("[DONE]"));
		}) as typeof fetch;
		const res = await model().postInputEvent({ type: "text", text: "hi" });
		assert.equal(res.status, 200);
	});

	it("waits out the turn, then re-POSTs the byte-identical event body", async () => {
		const calls = installFetch({
			chatPOST: (n) => new Response("x", { status: n === 1 ? 409 : 200 }),
			jobsGET: (poll) => poll <= 1,
		});
		const res = await model({ pollMs: 10, waitMaxMs: 100 }).postInputEvent({ type: "text", text: "my question" });
		assert.equal(res.status, 200);
		const posts = calls.filter((c) => c.url === "/api/chat");
		assert.equal(posts.length, 2);
		assert.equal(posts[1]!.body, posts[0]!.body);
	});

	it("gives up after the deadline and surfaces the last 409", async () => {
		const calls = installFetch({ chatPOST: () => new Response("busy", { status: 409 }), jobsGET: () => true });
		const res = await model({ pollMs: 10, waitMaxMs: 100 }).postInputEvent({ type: "text", text: "q" });
		assert.equal(res.status, 409);
		const polls = calls.filter((c) => c.url.startsWith("/api/jobs")).length;
		assert.ok(polls <= 15, `expected bounded polling, got ${polls}`);
	});
});

describe("send (one input event, verbatim consumption)", () => {
	it("optimistically appends the text, POSTs {chatId, input}, consumes to [DONE]", async () => {
		const posts: string[] = [];
		globalThis.fetch = dietFetch({
			onPost: (b) => posts.push(b),
			userText: "my topic",
			stream: () => sseResponse({ type: "agent_start" }, ...reply("hello there"), { type: "agent_end", messages: [] }, "[DONE]"),
		});
		const m = model();
		const pending = m.send({ type: "text", text: "my topic" });
		assert.equal(m.getState().status, "submitted");
		assert.match(m.getState().nativeMessages.at(-1)?.id ?? "", /^c_/);
		assert.equal(m.getState().messages.at(-1)!.parts[0]!.text, "my topic");
		await pending;
		assert.deepEqual(JSON.parse(posts[0]!), { chatId: "chat_x", input: { type: "text", text: "my topic" } });
		assert.equal(m.getState().status, "ready");
		assert.equal(m.getState().messages.at(-1)!.parts.at(-1)!.text, "hello there");
	});

	it("N id-less updates replace the SAME tail slot (the per-chunk divider bug pin)", async () => {
		const { response, push } = pushed();
		globalThis.fetch = dietFetch({ userText: "go", stream: () => response });
		const m = model();
		const done = m.send({ type: "text", text: "go" });
		const settle = () => new Promise((r) => setTimeout(r, 0));

		push({ type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } });
		for (const text of ["Hel", "Hello", "Hello wor", "Hello world"]) {
			push(partial([{ type: "thinking", thinking: "hmm" }, { type: "text", text }]));
			await settle();
		}
		const assistants = () => m.getState().nativeMessages.filter((x) => x.role === "assistant");
		assert.equal(assistants().length, 1, "one streaming message, replaced in place");
		assert.equal(m.getState().messages.at(-1)!.parts.filter((p) => p.type === "text").length, 1);
		assert.equal(m.getState().messages.at(-1)!.parts.at(-1)!.text, "Hello world");
		const idMid = assistants()[0]!.id;
		assert.match(idMid, /^c_/);

		push({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hello world" }], stopReason: "stop" } });
		push({ type: "agent_end", messages: [] });
		push("[DONE]");
		await done;
		assert.deepEqual(assistants().map((x) => x.id), [idMid], "same slot through message_end");
	});

	it("the optimistic answer result attaches to the pending quiz part at once", async () => {
		let postBody = "";
		const m = model({
			initialMessages: [newUserMessage("hi"), assistantWithCall("call-1", "call-1", "quiz")],
			fetch: async (url, init) => {
				if (String(url) !== "/api/chat") throw new Error(`unexpected fetch: ${String(url)}`);
				postBody = init?.body as string;
				return sseResponse("[DONE]");
			},
		});
		const pending = m.submitAnswer("quiz", "call-1", { correct: true } as never);
		const quizPart = m.getState().messages.flatMap((v) => v.parts).find((p) => p.type === "tool-quiz")!;
		assert.equal(quizPart.state, "output-available");
		assert.deepEqual(quizPart.output, { correct: true });
		await pending;
		assert.deepEqual(JSON.parse(postBody), { chatId: "chat_x", input: { type: "answer", toolCallId: "call-1", answer: { correct: true } } });
	});

	it("ignores the question placeholder's clean execution end (fork 2) and keeps errors", async () => {
		const { response, push } = pushed();
		globalThis.fetch = dietFetch({ userText: "q", stream: () => response });
		const m = model();
		const done = m.send({ type: "text", text: "q" });
		const settle = () => new Promise((r) => setTimeout(r, 0));
		const quizParts = () => m.getState().messages.flatMap((v) => v.parts).filter((p) => p.type === "tool-quiz");
		const calls = ["q1", "bad1"].map((id) => ({ type: "toolCall", id, name: "quiz", arguments: {} }));
		push({ type: "message_start", message: { role: "assistant", content: calls } });
		await settle();
		push({ type: "tool_execution_end", toolCallId: "q1", toolName: "quiz", isError: false, result: { content: [{ type: "text", text: "Question posed" }], details: { placeholder: true } } });
		push({ type: "tool_execution_end", toolCallId: "bad1", toolName: "quiz", isError: true, result: { content: [{ type: "text", text: "bad option" }], details: undefined } });
		await settle();
		assert.deepEqual(quizParts().map((p) => p.state), ["input-available", "output-error"], "the dock mounts on the placeholder");
		assert.equal(quizParts()[1]!.errorText, "bad option");
		push({
			type: "turn_end",
			message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "toolUse" },
			toolResults: [{ id: "tr_q1", role: "toolResult", toolCallId: "q1", toolName: "quiz", content: [{ type: "text", text: "Question posed — the turn ends here; the learner's graded answer arrives as this call's result." }], details: null, isError: false }],
		});
		await settle();
		assert.equal(quizParts()[0]!.state, "input-available", "the placeholder toolResult keeps the mount state");
		assert.equal(quizParts()[0]!.output, undefined, "no null output reaches the AnsweredCard");
		push({ type: "agent_end", messages: [] });
		push("[DONE]");
		await done;
	});

	it("markers injected mid-run append to the tail and upsert by id", () => {
		const m = model({ initialMessages: [userText("u1", "hello")], fetch: () => new Promise<Response>(() => {}) });
		void m.send({ type: "text", text: "hello" });
		const marker = { id: "steer_job_x_1", role: "custom", customType: "subagent-steer", content: "arrived", display: true, details: { jobId: "job_x", kind: "research" }, timestamp: 2 };
		m.applyWireEvent({ type: "message_start", message: marker } as never);
		m.applyWireEvent({ type: "message_end", message: marker } as never);
		const count = m.getState().messages.length;
		assert.ok(m.getState().messages.at(-1)!.parts.some((p) => p.type === "data-subagent-artifact"));
		m.applyWireEvent({ type: "message_end", message: marker } as never);
		assert.equal(m.getState().messages.length, count, "same id upserts");
	});
});

describe("provider-error banner (live and saved)", () => {
	function failed(id = "failed", errorMessage: string | undefined = "Google 500: fixture failure"): LhMessage {
		return { ...assistantMsg(id, ""), content: [], stopReason: "error", errorMessage } as LhMessage;
	}

	it("restores an empty failed response on load and full sync without adding a transcript card", () => {
		const record = [newUserMessage("topic"), failed()];
		const m = model({ initialMessages: record });
		assert.equal(m.getState().error?.message, "Google 500: fixture failure");
		assert.equal(m.getState().status, "ready");
		assert.equal(m.readyRef, true, "a restored provider failure does not block retry");
		assert.deepEqual(m.getState().nativeMessages, record, "diagnostic history stays intact");
		assert.equal(m.getState().messages.length, 1, "only the user bubble, no permanent error card");
		const synced = model();
		synced.setMessages(record);
		assert.equal(synced.getState().error?.message, m.getState().error?.message);
		const adopted = model({ initialMessages: record.slice(0, 1) });
		adopted.adoptRecord(record);
		assert.equal(adopted.getState().error?.message, m.getState().error?.message);
	});

	it("substantive later input/output supersedes the failure, including aborts", () => {
		const failure = failed();
		const later: LhMessage[] = [
			newUserMessage("retry"),
			assistantMsg("success", "Hello"),
			{ ...assistantMsg("aborted", ""), stopReason: "aborted", errorMessage: "Aborted" } as LhMessage,
			newThinkingMessage("problem", "my attempt"),
			resultMsg("call"),
		];
		for (const entry of later) {
			const m = model({ initialMessages: [failure] });
			m.applyWireEvent({ type: "message_end", message: failure });
			assert.ok(m.getState().error, "the live failure is initially visible");
			m.setMessages([failure, entry]);
			assert.equal(m.getState().error, null, `live banner superseded by ${entry.role}`);
			assert.equal(model({ initialMessages: [failure, entry] }).getState().error, null, "reopened view agrees");
		}
	});

	for (const input of [{ type: "text", text: "retry" }, { type: "continue" }, { type: "retry" }] as const) {
		it(`hides the old failure during the optimistic ${input.type} wait, then shows a new live failure`, async () => {
			let acknowledge!: (response: Response) => void;
			const ack = new Promise<Response>((resolve) => { acknowledge = resolve; });
			const old = failed("old", "old failure");
			const fresh = failed("fresh", "new failure");
			let finish!: () => void;
			const stream = new ReadableStream<Uint8Array>({ start(controller) {
				finish = () => {
					controller.enqueue(new TextEncoder().encode(sse("[DONE]")));
					controller.close();
				};
			} });
			const m = model({ initialMessages: [old], fetch: async (url) => {
				if (url === "/api/chat") return ack;
				if (url === "/api/chats/chat_x") return Response.json({ messages: [old] });
				if (url === "/api/chats/chat_x/stream") return new Response(stream);
				throw new Error(`unexpected fetch: ${url}`);
			} });
			assert.equal(m.getState().error?.message, "old failure");
			const sending = m.send(input);
			assert.equal(m.getState().status, "submitted");
			assert.equal(m.getState().error, null, "hidden even before the acknowledgement");
			acknowledge(Response.json({ ok: true }));
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(m.getState().error, null, "refetching the old failed record does not resurrect it");
			m.applyWireEvent({ type: "message_start", message: fresh });
			assert.equal(m.getState().error, null, "no error from an unfinished partial");
			m.applyWireEvent({ type: "message_end", message: fresh });
			assert.equal(m.getState().status, "submitted");
			assert.equal(m.getState().error?.message, "new failure", "new failure appears before stream closure");
			finish();
			await sending;
			assert.equal(m.getState().error?.message, "new failure");
		});
	}

	it("hides the old failure immediately on fresh-mount reattach, and restores final-entry truth at idle", async () => {
		let settle!: (response: Response) => void;
		const response = new Promise<Response>((resolve) => { settle = resolve; });
		const m = model({ initialMessages: [failed()], fetch: async () => response });
		const attaching = m.resumeStream(false);
		assert.equal(m.getState().status, "submitted");
		assert.equal(m.getState().error, null);
		settle(sseResponse({ type: "turn-settled" }, "[DONE]"));
		await attaching;
		assert.equal(m.getState().error?.message, "Google 500: fixture failure", "no newer entry superseded it");
	});

	it("recovers a failure that settled before the submitter could attach to its stream", async () => {
		const record = [newUserMessage("topic"), failed()];
		const m = model({ fetch: dietFetch({ record, stream: () => sseResponse({ type: "turn-settled" }, "[DONE]") }) });
		m.setReattachSettled(() => m.setMessages(record));
		await m.send({ type: "text", text: "topic" });
		assert.equal(m.getState().status, "ready");
		assert.equal(m.getState().error?.message, "Google 500: fixture failure");
	});

	it("an aborted older consume cannot restore the old banner during a replacement reattach", async () => {
		let attempts = 0;
		let firstRead!: () => void;
		const reading = new Promise<void>((resolve) => { firstRead = resolve; });
		let settleReplacement!: (response: Response) => void;
		const replacement = new Promise<Response>((resolve) => { settleReplacement = resolve; });
		const m = model({ initialMessages: [failed()], fetch: async (_url, init) => {
			if (++attempts > 1) return replacement;
			return new Response(new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(sse({ type: "agent_start" })));
					init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
				},
				pull() { firstRead(); },
			}));
		} });
		const first = m.resumeStream(false);
		await reading;
		const second = m.resumeStream(false);
		await first;
		assert.equal(m.getState().status, "submitted", "old cleanup must not settle the replacement attempt");
		assert.equal(m.getState().error, null, "old saved failure stays hidden during the replacement's Thinking wait");
		settleReplacement(sseResponse(
			{ type: "message_start", message: failed("new", "replacement failure") },
			{ type: "message_end", message: failed("new", "replacement failure") },
			"[DONE]",
		));
		await second;
		assert.equal(m.getState().error?.message, "replacement failure");
	});

	it("keeps loop/request errors transient, with the existing precedence and clearError behavior", async () => {
		const m = model({ initialMessages: [failed()] });
		m.applyWireEvent({ type: "error", errorText: "loop failure" });
		assert.equal(m.getState().error?.message, "loop failure");
		assert.equal(model({ initialMessages: m.getState().nativeMessages }).getState().error?.message, "Google 500: fixture failure");
		m.clearError();
		assert.equal(m.getState().error?.message, "Google 500: fixture failure");
		m.fetch = async () => new Response("request refused", { status: 500 });
		await m.send({ type: "text", text: "retry" });
		assert.equal(m.getState().error?.message, "request refused");
		assert.equal(model({ initialMessages: m.getState().nativeMessages }).getState().error, null, "request errors are not fabricated as saved messages");
		m.clearError();
		assert.equal(m.getState().error, null);
	});
});

describe("truncated stream recovery", () => {
	const DROPPED = "The connection dropped before the turn completed.";
	const truncated = () => sseResponse({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
	const completed = () => sseResponse(...reply("complete"), "[DONE]");
	/** A model whose Nth stream (1-based) is `stream(n)`; counts posts and streams. */
	function streamed(stream: (n: number) => Response, extra: Partial<ConstructorParameters<typeof SessionModel>[0]> = {}) {
		const counts = { posts: 0, streams: 0 };
		const m = model({ ...extra, fetch: dietFetch({ userText: "go", onPost: () => counts.posts++, stream: () => stream(++counts.streams) }) });
		return { m, counts };
	}

	it("reattaches once after EOF without DONE and replaces the incomplete replay", async () => {
		const { m, counts } = streamed((n) => (n === 1 ? truncated() : completed()));
		await m.send({ type: "text", text: "go" });
		assert.equal(counts.streams, 2);
		assert.equal(m.status, "ready");
		assert.equal(m.getState().error, null);
		assert.equal(m.getState().nativeMessages.filter((x) => x.role === "assistant").length, 1);
		assert.equal(m.getState().messages.at(-1)!.parts.at(-1)!.text, "complete");
	});

	it("surfaces the connection error after a second truncation without retrying the input", async () => {
		const { m, counts } = streamed(() => truncated());
		await m.send({ type: "text", text: "go" });
		assert.deepEqual(counts, { posts: 1, streams: 2 });
		assert.equal(m.status, "error");
		assert.equal(m.getState().error?.message, DROPPED);
	});

	it("reports the connection error when the recovery record read fails", async () => {
		let reads = 0;
		const m = model({ fetch: async (url) => {
			if (String(url) === "/api/chat") return Response.json({ ok: true });
			if (String(url).endsWith("/stream")) return truncated();
			if (++reads === 1) return Response.json({ messages: [] });
			throw new TypeError("synthetic offline");
		} });
		await m.send({ type: "text", text: "go" });
		assert.equal(m.status, "error");
		assert.equal(m.getState().error?.message, DROPPED);
	});

	it("accepts turn-settled when the original turn finished during the disconnection", async () => {
		let settled = 0;
		const { m, counts } = streamed((n) => (n === 1 ? truncated() : sseResponse({ type: "turn-settled" }, "[DONE]")), { onReattachSettled: () => { settled++; } });
		await m.send({ type: "text", text: "go" });
		assert.equal(counts.streams, 2);
		assert.equal(settled, 1);
		assert.equal(m.status, "ready");
		assert.equal(m.getState().error, null);
	});

	it("recovers a rejected body read but does not relabel event-application bugs", async () => {
		const rejected = () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("synthetic read failure")); } }));
		const ok = streamed((n) => (n === 1 ? rejected() : completed()));
		await ok.m.send({ type: "text", text: "go" });
		assert.equal(ok.counts.streams, 2);
		assert.equal(ok.m.status, "ready");
		const broken = streamed(() => completed());
		broken.m.applyWireEvent = () => { throw new Error("synthetic event application bug"); };
		await broken.m.send({ type: "text", text: "go" });
		assert.equal(broken.counts.streams, 1);
		assert.equal(broken.m.getState().error?.message, "synthetic event application bug");
	});

	it("preserves malformed-event diagnostics rather than calling them network drops", async () => {
		const { m, counts } = streamed(() => new Response("data: {broken}\n\n"));
		await m.send({ type: "text", text: "go" });
		assert.equal(counts.streams, 1);
		assert.equal(m.status, "error");
		assert.match(m.getState().error!.message, /JSON|property name/);
	});

	it("a superseded consume cannot recover or overwrite its replacement's state", async () => {
		let streams = 0;
		let closeFirst!: () => void;
		let beganReading!: () => void;
		const reading = new Promise<void>(resolve => { beganReading = resolve; });
		const m = model({ fetch: dietFetch({ stream: () => ++streams === 1 ? new Response(new ReadableStream({
			start(controller) { closeFirst = () => controller.close(); },
			pull() { beganReading(); },
		}, { highWaterMark: 0 })) : completed() }) });
		const first = m.resumeStream(false);
		await reading;
		await m.resumeStream(false);
		closeFirst();
		await first;
		assert.equal(streams, 2);
		assert.equal(m.status, "ready");
		assert.equal(m.getState().error, null);
		assert.equal(m.getState().messages.at(-1)!.parts.at(-1)!.text, "complete");
	});
});

describe("automatic continuation after recovery failure", () => {
	const question = { ...assistantMsg("question", ""), content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { question: "Q?" } }] } as LhMessage;
	const answer = buildAnswer({ id: "q1", kind: "quiz", question: "Q?", mode: "single-select", options: [], createdAt: "fixture" }, { dontKnow: true });
	const answered = [question, newAnswerResult("q1", "quiz", answer)];
	const SAVE_FAILED = "The reply could not be saved.";
	const counted = (initialError?: string) => {
		const c = { posts: 0, m: undefined as unknown as SessionModel };
		c.m = model({ initialMessages: answered, initialError, fetch: dietFetch({ onPost: () => c.posts++, stream: () => sseResponse("[DONE]") }) });
		return c;
	};

	it("a retained failure blocks continuation even after banner dismissal; explicit input still sends", async () => {
		const c = counted(SAVE_FAILED);
		assert.equal(SessionModel.needsContinuation(answered), true);
		assert.equal(c.m.getState().error?.message, SAVE_FAILED);
		await c.m.continueIfOwed(answered);
		c.m.clearError();
		await c.m.continueIfOwed(answered);
		assert.equal(c.posts, 0, "closing the banner is not permission to retry the model");
		await c.m.send({ type: "text", text: "explicit learner input" });
		assert.equal(c.posts, 1);
		assert.equal(c.m.getState().error, null);
	});

	it("a new server-owned turn clears the retained banner without releasing Thinking", () => {
		const { m } = counted(SAVE_FAILED);
		assert.equal(m.applyWireEvent({ type: "agent_start" }), false);
		assert.equal(m.getState().error, null);
	});

	it("a healthy owed continuation starts once", async () => {
		const c = counted();
		await c.m.continueIfOwed(answered);
		assert.equal(c.posts, 1);
	});
});

describe("answer submission recovery", () => {
	const question = {
		...assistantMsg("question", "Q?"),
		content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { question: "Q?", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "A is correct." } }],
	} as LhMessage;
	const answer = buildAnswer({ id: "q1", kind: "quiz", question: "Q?", mode: "single-select", options: [], createdAt: "fixture" }, { dontKnow: true, thinking: "keep my reasoning" });
	const newer = { ...question, id: "new-question" } as LhMessage;
	const offline = (): Response => { throw new TypeError("offline"); };
	const refused = () => new Response("refused", { status: 500 });

	/** Logs URLs; POSTs and dismissals answer `post(n)`; record reads return `record`. */
	function server(post: (n: number) => Response, record: LhMessage[] = [question], turnInFlight = false) {
		const s = { calls: [] as string[], posts: 0, fetch: (async (input: RequestInfo | URL) => {
			const url = String(input);
			s.calls.push(url);
			if (url === "/api/chat" || url.endsWith("/dismiss")) return post(++s.posts);
			if (url.endsWith("/stream")) return sseResponse("[DONE]");
			return Response.json({ messages: record, turnInFlight });
		}) as typeof globalThis.fetch };
		return s;
	}

	it("restores the question after a failed POST and checks the record before another POST", async () => {
		const s = server((n) => (n === 1 ? refused() : Response.json({ ok: true })));
		const m = model({ initialMessages: [question], fetch: s.fetch });
		await m.submitAnswer("quiz", "q1", answer);
		assert.equal(m.getState().messages[0]!.parts.find((p) => p.toolCallId === "q1")!.state, "input-available");
		assert.equal(m.status, "error");
		m.clearError(); // dismissing the banner must not disable recovery
		await m.submitAnswer("quiz", "q1", answer);
		assert.equal(s.posts, 2);
		assert.deepEqual(s.calls.slice(0, 3), ["/api/chat", "/api/chats/chat_x", "/api/chat"]);
	});

	it("retains all submitted draft channels until the canonical answer resolves the call", async () => {
		const form = { selection: { selected: new Set([1]), otherSelected: true, dontKnow: false }, thinking: "reasoning", other: "custom answer", text: "free text", confidenceIndex: 4 };
		const m = model({ initialMessages: [question], fetch: async () => offline() });
		m.saveQuestionDraft("q1", { form });
		m.saveQuestionDraft("q1", { readingThinking: "reading reasoning" });
		await m.submitAnswer("quiz", "q1", answer);
		m.setMessages([question]);
		assert.deepEqual(m.questionDraft("q1"), { form, readingThinking: "reading reasoning" });
		assert.equal(m.questionDraft("q2"), undefined);
		m.adoptRecord([question, newAnswerResult("q1", "quiz", answer)]);
		assert.equal(m.questionDraft("q1"), undefined, "only confirmed native resolution clears it");
	});

	it("a final 409 restores the question instead of leaving an optimistic answer", async () => {
		const m = model({ initialMessages: [question], waitMaxMs: 0, fetch: async () => new Response("busy", { status: 409 }) });
		await m.submitAnswer("quiz", "q1", answer);
		assert.equal(m.getState().nativeMessages.length, 1);
		assert.equal(m.status, "error");
	});

	it("does not repost an answer whose acceptance acknowledgement was lost", async () => {
		const saved = JSON.parse(JSON.stringify([question, newAnswerResult("q1", "quiz", answer)])) as LhMessage[];
		const s = server(offline, saved);
		const m = model({ initialMessages: [question], fetch: s.fetch });
		await m.submitAnswer("quiz", "q1", answer);
		await m.submitAnswer("quiz", "q1", answer);
		assert.equal(s.posts, 1);
		assert.equal(m.status, "ready");
		assert.deepEqual(m.getState().nativeMessages, saved);
	});

	it("reattaches to an accepted running turn instead of posting another answer", async () => {
		const s = server(offline, [question, newAnswerResult("q1", "quiz", answer)], true);
		const m = model({ initialMessages: [question], fetch: s.fetch });
		await m.submitAnswer("quiz", "q1", answer);
		await m.submitAnswer("quiz", "q1", answer);
		assert.deepEqual(s.calls, ["/api/chat", "/api/chats/chat_x", "/api/chats/chat_x/stream"]);
		assert.equal(m.status, "ready");
	});

	it("keeps the question and makes no further POST while reconciliation is unreachable", async () => {
		const calls: string[] = [];
		const m = model({ initialMessages: [question], fetch: async (url) => { calls.push(String(url)); return offline(); } });
		await m.submitAnswer("quiz", "q1", answer);
		await m.submitAnswer("quiz", "q1", answer);
		assert.deepEqual(calls, ["/api/chat", "/api/chats/chat_x"]);
		assert.equal(m.status, "error");
		assert.equal(m.getState().nativeMessages.some((x) => x.role === "toolResult"), false);
	});

	for (const dismiss of [false, true]) {
		it(`accepts a ${dismiss ? "dismissal" : "submission and retry"} while a live question placeholder is in the tail`, async () => {
			const s = server(refused);
			const m = model({ initialMessages: [question], fetch: s.fetch });
			m.applyWireEvent({ type: "turn_end", message: question, toolResults: [{ role: "toolResult", toolCallId: "q1", toolName: "quiz",
				content: [{ type: "text", text: "Question posed" }], details: null, isError: false, timestamp: 1 }] });
			const key = pendingQuestionOf([question])!.key;
			if (dismiss) await m.dismissQuestion("q1", answer, key);
			else {
				await m.submitAnswer("quiz", "q1", answer, key);
				await m.submitAnswer("quiz", "q1", answer, key);
			}
			assert.equal(s.posts, dismiss ? 1 : 2, "placeholder must not reject the render's question identity");
		});
	}

	it("an old same-id answer does not count as resolving the current question", async () => {
		const record = [question, newAnswerResult("q1", "quiz", answer), newer];
		const s = server(refused, record);
		const m = model({ initialMessages: record, fetch: s.fetch });
		const key = pendingQuestionOf(record)!.key;
		m.saveQuestionDraft(key, { readingThinking: "NEW reasoning" });
		await m.submitAnswer("quiz", "q1", answer, key);
		await m.submitAnswer("quiz", "q1", answer, key);
		assert.equal(s.posts, 2);
		assert.equal(m.questionDraft(key)?.readingThinking, "NEW reasoning");
		m.setMessages([...record, newAnswerResult("q1", "quiz", answer)]);
		assert.equal(m.questionDraft(key), undefined);
	});

	it("adopts a newer same-id occurrence instead of reposting an older question's answer", async () => {
		const s = server(offline, [question, newer]);
		const m = model({ initialMessages: [question], fetch: s.fetch });
		const key = pendingQuestionOf([question])!.key;
		await m.submitAnswer("quiz", "q1", answer, key);
		await m.submitAnswer("quiz", "q1", answer, key);
		assert.equal(s.posts, 1);
		assert.equal(m.status, "ready");
		assert.equal(pendingQuestionOf(m.getState().nativeMessages)?.messageId, "new-question");
	});

	it("rejects stale render callbacks locally, including same-id silent dismissals", async () => {
		const s = server(() => Response.json({ ok: true }));
		const m = model({ initialMessages: [question], fetch: s.fetch });
		const oldKey = pendingQuestionOf([question])!.key;
		m.setMessages([question, newer]);
		await m.submitAnswer("quiz", "q1", answer, oldKey);
		await m.dismissQuestion("q1", answer, oldKey);
		assert.equal(s.calls.length, 0);
		assert.equal(m.getState().nativeMessages.length, 2);
	});

	it("does not leak drafts between same-id questions, and preserves unique-id live handover", () => {
		const m = model({ initialMessages: [question] });
		const oldKey = pendingQuestionOf([question])!.key;
		m.saveQuestionDraft(oldKey, { readingThinking: "old reasoning" });
		m.setMessages([question, newer]);
		const newKey = pendingQuestionOf([question, newer])!.key;
		assert.notEqual(oldKey, newKey);
		assert.equal(m.questionDraft(newKey), undefined);
		assert.equal(m.questionDraft(oldKey), undefined);

		const live = { ...question, id: "c_live" };
		m.setMessages([live]);
		m.saveQuestionDraft(pendingQuestionOf([live])!.key, { readingThinking: "live reasoning" });
		m.setMessages([question]);
		assert.equal(m.questionDraft(pendingQuestionOf([question])!.key)?.readingThinking, "live reasoning");
	});
});

describe("resumeStream (the reattach path)", () => {
	it("a fresh-mount reattach attaches first, with no blocking record refetch", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			urls.push(String(input));
			if (String(input) === "/api/chats/chat_x/stream") return sseResponse(...reply("hi"), { type: "agent_end", messages: [] }, "[DONE]");
			throw new Error(`unexpected fetch: ${String(input)}`);
		}) as typeof globalThis.fetch;
		const m = model();
		await m.resumeStream(false);
		assert.deepEqual(urls, ["/api/chats/chat_x/stream"]);
		assert.equal(m.getState().status, "ready");
	});

	it("protocol events keep the optimistic placeholder; the first applied event flips streaming", async () => {
		let releaseProtocol!: () => void;
		let releaseRest!: () => void;
		const protocolGate = new Promise<void>((res) => (releaseProtocol = res));
		const restGate = new Promise<void>((res) => (releaseRest = res));
		const body = gated(
			[{ type: "agent_start" }, { type: "turn_start" }],
			protocolGate,
			[{ type: "message_start", message: { role: "assistant", content: [] } }],
			restGate,
			[{ type: "agent_end", messages: [] }, "[DONE]"],
		);
		globalThis.fetch = dietFetch({ userText: "q", stream: () => body });
		const m = model();
		const p = m.send({ type: "text", text: "q" });
		assert.equal(m.getState().status, "submitted");
		await new Promise((r) => setTimeout(r, 25));
		assert.equal(m.getState().status, "submitted", "protocol events apply nothing");
		releaseProtocol();
		await new Promise((r) => setTimeout(r, 25));
		assert.equal(m.getState().status, "streaming");
		releaseRest();
		await p;
		assert.equal(m.getState().status, "ready");
	});

	it("a session start survives stop() racing the submit (owner, 2026-10-10)", async () => {
		let resolvePost!: () => void;
		let postAborted = false;
		const fetches: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			fetches.push(url);
			if (url === "/api/chat") {
				init?.signal?.addEventListener("abort", () => (postAborted = true));
				await new Promise<void>((r) => (resolvePost = r));
				return Response.json({ ok: true });
			}
			if (url === "/api/chats/chat_x") return Response.json({ messages: [{ id: "u1", role: "user", content: "quiz me", timestamp: 1 }] });
			if (url === "/api/chats/chat_x/stream") return sseResponse("[DONE]");
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const m = model();
		const sending = m.send({ type: "text", text: "quiz me" });
		await new Promise((r) => setTimeout(r, 5));
		m.stop(); // StrictMode's simulated unmount lands mid-submit
		resolvePost();
		await sending;
		assert.equal(postAborted, false, "the submit POST carries no teardown signal");
		assert.ok(fetches.includes("/api/chat"));
		assert.ok(!fetches.some((u) => u.endsWith("/stream")), "a dead view attaches no stream");
		assert.equal(m.getState().status, "ready");
	});

	it("a reattach replays onto a clean slate: an aborted attempt's partials never double", async () => {
		let hold!: () => void;
		const holdGate = new Promise<void>((res) => (hold = res));
		let calls = 0;
		globalThis.fetch = (async () => ++calls === 1
			? gated([{ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "part one" }] } }], holdGate, [{ type: "agent_end", messages: [] }, "[DONE]"])
			: sseResponse({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "part one" }] } }, { type: "agent_end", messages: [] }, "[DONE]")) as typeof globalThis.fetch;
		const m = model();
		const attempt1 = m.resumeStream(false);
		await new Promise((r) => setTimeout(r, 25));
		const attempt2 = m.resumeStream(false);
		hold();
		await Promise.allSettled([attempt1, attempt2]);
		const texts = m.getState().messages.flatMap((msg) => msg.parts.filter((p) => p.type === "text").map((p) => p.text));
		assert.deepEqual(texts, ["part one"]);
	});

	it("a replayed continuation mounts beside the seeded message", async () => {
		globalThis.fetch = dietFetch({ record: [assistantMsg("seed", "the question")], stream: () => sseResponse(...reply("the reaction"), { type: "agent_end", messages: [] }, "[DONE]") });
		const m = model({ initialMessages: [assistantMsg("seed", "the question")] });
		await m.resumeStream();
		const view = m.getState().messages;
		assert.equal(view.length, 1, "one continuous assistant document");
		assert.deepEqual(view[0]!.parts.map((p) => p.type), ["step-start", "text", "step-start", "text"]);
	});

	it("survives a body split byte-by-byte across reads", async () => {
		globalThis.fetch = dietFetch({ stream: () => dripped(sse(...reply("hi"), "[DONE]"), 1) });
		const m = model();
		await m.resumeStream();
		assert.equal(m.getState().messages.at(-1)!.parts.at(-1)!.text, "hi");
	});
});

function userText(id: string, text: string): LhMessage {
	return { ...newUserMessage(text), id };
}

describe("adoptRecord — append-only adoption", () => {
	it("splices a server-added steer between the record and the live tail", () => {
		const m = model({ initialMessages: [userText("u1", "topic")] });
		m.applyWireEvent({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "streaming" }] } });
		m.adoptRecord([userText("u1", "topic"), userText("steer_1", "steered content")]);
		const ids = m.getState().nativeMessages.map((x) => x.id);
		assert.deepEqual(ids.slice(0, 2), ["u1", "steer_1"]);
		assert.match(ids[2] ?? "", /^c_/, "the live streaming tail stays last");
	});

	it("a missing base id (record rewrite) is a no-op — the idle full sync is the net", () => {
		const m = model({ initialMessages: [userText("u1", "a"), userText("u2", "b")] });
		m.adoptRecord([userText("u2", "b")]);
		assert.deepEqual(m.getState().nativeMessages.map((x) => x.id), ["u1", "u2"]);
	});

	it("absorbs only optimistic c_ entries the record has taken over", () => {
		const local = (msg: LhMessage, id: string) => ({ ...msg, id }) as LhMessage;
		const serverCopy = local(newUserMessage("my question"), "srv_9");
		assert.ok(absorbed(local(newUserMessage("my question"), "c_local_1"), [userText("u1", "topic"), serverCopy]), "text by content");
		assert.ok(!absorbed(serverCopy, [local(newUserMessage("my question"), "c_local_1")]), "server stamps are never absorbed");
		assert.ok(!absorbed(newUserMessage("my question"), [serverCopy]), "an id-less message is never absorbed");
		assert.ok(
			absorbed(local(newAnswerResult("call-1", "quiz", { correct: true }), "c_local_2"), [local(newAnswerResult("call-1", "quiz", { correct: true }), "srv_10")]),
			"answers by toolCallId",
		);
		const thinking = local(newThinkingMessage("call-p1", "my trace"), "c_opt1");
		assert.ok(absorbed(thinking, [...poseRecord(), local(newThinkingMessage("call-p1", "my trace"), "srv_1")]), "thinking by customType + details");
		assert.ok(!absorbed(thinking, [...poseRecord(), local(newThinkingMessage("call-p1", "a later trace"), "srv_2")]), "different details → own marker");
	});

	it("the adoption window cannot double the optimistic thinking card", () => {
		const m = model({ initialMessages: poseRecord() });
		m.applyWireEvent({ type: "message_start", message: { ...newThinkingMessage("call-p1", "my trace"), id: "c_opt1" } as LhMessage });
		m.adoptRecord([...poseRecord(), { ...newThinkingMessage("call-p1", "my trace"), id: "srv_1" } as LhMessage]);
		const customs = m.getState().nativeMessages.filter((x) => x.role === "custom");
		assert.deepEqual(customs.map((x) => x.id), ["srv_1"]);
	});
});

function assistantWithCall(id: string, callId: string | string[], name = "research"): LhMessage {
	const ids = Array.isArray(callId) ? callId : [callId];
	return {
		id,
		role: "assistant",
		content: ids.map((c) => ({ type: "toolCall", id: c, name, arguments: { topic: "x" } })),
		stopReason: "toolUse",
		usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 },
		provider: "openrouter",
		model: "test",
		timestamp: 0,
	} as unknown as LhMessage;
}

function resultMsg(callId: string, name = "research"): LhMessage {
	return { ...newAnswerResult(callId, name, { ok: true }), id: `r_${callId}` } as unknown as LhMessage;
}

describe("needsContinuation + endsInDismissal (the dismissal pause)", () => {
	const dismissed = (callId: string) =>
		({ ...newAnswerResult(callId, "quiz", dismissedAnswer("quiz", "Pick a planet")), id: `d_${callId}` }) as unknown as LhMessage;
	const topic = userText("u1", "topic");
	const pair = assistantWithCall("a1", ["call-a", "call-b"], "quiz");
	const cases: [string, LhMessage[], boolean, boolean][] = [
		["answered tool call continues", [topic, assistantWithCall("a1", "call-r1"), resultMsg("call-r1")], true, false],
		["dangling question never fires", [topic, assistantWithCall("a1", "call-q1", "quiz")], false, false],
		["parallel quizzes: one open", [topic, pair, resultMsg("call-a", "quiz")], false, false],
		["parallel quizzes: all answered", [topic, pair, resultMsg("call-a", "quiz"), resultMsg("call-b", "quiz")], true, false],
		["all dismissed pauses", [topic, assistantWithCall("a1", "call-q1", "quiz"), dismissed("call-q1")], false, true],
		["answered then dismissed: last resolution decides", [topic, pair, resultMsg("call-a", "quiz"), dismissed("call-b")], false, true],
		["dismissed then answered: reaction owed", [topic, pair, dismissed("call-a"), resultMsg("call-b", "quiz")], true, false],
		["a user message un-pauses", [topic, assistantWithCall("a1", "call-q1", "quiz"), dismissed("call-q1"), userText("u2", "moving on")], false, false],
	];
	for (const [name, messages, owed, paused] of cases) {
		it(name, () => {
			assert.equal(needsContinuation(messages), owed, "needsContinuation");
			assert.equal(endsInDismissal(messages), paused, "endsInDismissal");
		});
	}
});

describe("newAnswerResult two audiences", () => {
	it("the model sees the compact learner-only record; details keeps the full graded answer", () => {
		const qd: QuestionData = {
			id: "call-1", kind: "quiz", question: "Closest planet?", mode: "single-select",
			options: [{ label: "Mercury", value: "mercury" }, { label: "Venus", value: "venus" }],
			correctIndices: [1], explanation: "Mercury orbits closest.", createdAt: "2026-01-01T00:00:00Z",
		};
		const full = buildAnswer(qd, { values: ["mercury"], confidence: 70, thinking: "guessed" });
		const msg = newAnswerResult("call-1", "quiz", full);
		assert.deepEqual(JSON.parse((msg.content as { type: "text"; text: string }[])[0]!.text), {
			kind: "quiz", answers: [{ index: 1, label: "Mercury" }], correct: true, confidence: 70, thinking: "guessed",
		});
		assert.equal(msg.details, full);
	});
});

/** The post-settle pose-turn record of a practice session. */
function poseRecord(): LhMessage[] {
	return [
		{ id: "m1", role: "user", content: "db practice" },
		{ id: "m3", role: "assistant", content: [{ type: "toolCall", id: "call-p1", name: "problem", arguments: { statement: "Q?" } }] },
		{ id: "m4", role: "toolResult", toolCallId: "call-p1", toolName: "problem", content: [{ type: "text", text: "Problem posed." }], details: null },
	] as unknown as LhMessage[];
}

describe("the live-view law — live is positive evidence, not session busyness", () => {
	it("a settled call never renders live during another turn; this turn's streaming call does", () => {
		const streaming = { id: "c_as1", role: "assistant", content: [{ type: "toolCall", id: "call-c1", name: "conclude", arguments: { outcome: "solved" } }] } as unknown as LhMessage;
		const view = projectView([...poseRecord(), streaming], { executions: new Map(), inFlight: true, streamingIds: new Set(["c_as1"]) });
		const parts = view.flatMap((m) => m.parts);
		assert.equal(parts.find((p) => p.type === "tool-problem")?.state, "input-available", "no two-spinner bug");
		assert.equal(parts.find((p) => p.type === "tool-conclude")?.state, "input-streaming");
	});
});
