import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { APP_IDENTITY, piEngineForSpec, type PiEngine } from "../src/agent/models.ts";
import { createProberAgent, createTeacherAgent, createPracticeAgent, type AgentBuildOptions } from "../src/agent/teacher-agent.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { healToolRecord } from "../src/agent/tools/heal.ts";
import metadata from "../package.json" with { type: "json" };

const factories = [
	(opts: AgentBuildOptions) => createProberAgent({ chatId: opts.chatId, searchAvailable: () => false } as never, opts),
	(opts: AgentBuildOptions) => createTeacherAgent(undefined, opts),
	(opts: AgentBuildOptions) => createPracticeAgent({} as never, opts),
];

function recordingEngine() {
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxToolCall("again", {}, { id: "call_0" })], { stopReason: "toolUse" }), { ...fauxAssistantMessage([fauxText("done")]), durationMs: 42 }]);
	const requests: SimpleStreamOptions[] = [];
	const engine: PiEngine = { model: faux.getModel(), streamFn: (model, context, options) => {
		requests.push(options ?? {});
		return faux.streamSimple(model, context, options);
	} };
	return { engine, requests };
}
const again = { name: "again", label: "again", description: "Continue", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }) };

// Whole-process replacement isolates native auth/profile discovery; fetch never
// delegates. No real credentials, .env, OAuth accounts, or model inference.
async function closed<T>(run: () => Promise<T>): Promise<T> {
	const env = process.env;
	const fetch = globalThis.fetch;
	process.env = { NODE_ENV: "test", HOME: "/nonexistent/session-identity", OPENROUTER_API_KEY: "dummy-router", OPENCODE_API_KEY: "dummy-go", OPENAI_API_KEY: "dummy-openai" };
	globalThis.fetch = async () => { throw new Error("CLOSED: unexpected fetch"); };
	try { return await run(); } finally { process.env = env; globalThis.fetch = fetch; }
}

describe("native app and conversation identity", { concurrency: false }, () => {
	it("shares one deeply frozen metadata-derived identity, without mutable conversation state", () => {
		assert.deepEqual(APP_IDENTITY, { userAgent: { custom: `learnharness/${metadata.version}` }, attribution: { name: metadata.name, url: metadata.homepage } });
		for (const value of [APP_IDENTITY, APP_IDENTITY.userAgent, APP_IDENTITY.attribution]) assert.ok(Object.isFrozen(value));
		assert.ok(!Object.hasOwn(APP_IDENTITY, "sessionId"));
	});

	it("reconstructed prober/teacher/practice Agents reuse the exact chat id across tool rounds", async () => {
		for (const chatId of ["chat_exact_native_123", "chat_independent_456"]) {
			for (const factory of factories) {
				const { engine, requests } = recordingEngine();
				const agent = factory({ engine, chatId, tools: { again } });
				assert.equal(agent.identity, APP_IDENTITY);
				assert.equal(agent.sessionId, chatId);
				await agent.prompt("offline");
				assert.equal(requests.length, 2);
				for (const options of requests) {
					assert.equal(options.sessionId, chatId);
					assert.deepEqual(options.identity, APP_IDENTITY);
					assert.ok(options.signal instanceof AbortSignal);
					assert.equal(options.apiKey, undefined);
				}
			}
		}
	});

	it("separate extractor/auditor/compaction invocations own distinct stable unsaved conversations", async () => {
		const ids = new Set<unknown>();
		// Compaction uses the shared runner with the researcher role.
		for (const role of ["extractor", "auditor", "researcher"] as const) {
			const { engine, requests } = recordingEngine();
			let usage = 0;
			const result = await runSubagent([again], { role, engine, chatId: "chat_shared_debug_only", systemPrompt: "offline", prompt: "offline", maxTurns: 3, onUsage: () => usage++ });
			assert.equal(requests.length, 2);
			assert.equal(usage, 2);
			const id = requests[0]!.sessionId;
			assert.match(id ?? "", /^[0-9a-f-]{36}$/);
			assert.notEqual(id, "chat_shared_debug_only");
			assert.ok(!ids.has(id));
			ids.add(id);
			for (const options of requests) { assert.equal(options.sessionId, id); assert.deepEqual(options.identity, APP_IDENTITY); }
			assert.ok(result.newMessages.some((m) => m.role === "toolResult" && typeof m.durationMs === "number"), "new native tool duration fields are preserved");
			assert.ok(result.newMessages.some((m) => m.role === "assistant" && typeof m.durationMs === "number"), "new native assistant duration fields are preserved");
		}
	});

	for (const [provider, id, endpoint] of [
		["opencode-go", "glm-5.3", "/inference/go/v1/chat/completions"],
		["openrouter", "openrouter/free", "/api/v1/chat/completions"],
	] as const) {
		it(`complete native ${provider}/${id} foreground serialization carries app identity and exact sessions`, async () => closed(async () => {
			const engine = piEngineForSpec({ provider, id, thinkingLevel: "off" });
			const requests: Request[] = [];
			globalThis.fetch = async (input, init) => { const request = new Request(input, init); requests.push(request); await request.text(); return new Response('{"error":{"message":"closed fixture"}}', { status: 400, headers: { "content-type": "application/json" } }); };
			for (const factory of factories) await factory({ engine, chatId: "chat_wire_exact", tools: {} }).prompt("offline");
			assert.equal(requests.length, 3);
			for (const request of requests) {
				assert.equal(new URL(request.url).pathname, endpoint);
				assert.equal(request.headers.get("user-agent"), `learnharness/${metadata.version}`);
				if (provider === "opencode-go") {
					assert.equal(new URL(request.url).origin, "https://opencode.ai");
					assert.equal(request.headers.get("x-opencode-client"), metadata.name);
					assert.equal(request.headers.get("x-opencode-session"), "chat_wire_exact");
					assert.ok(!JSON.stringify(Object.fromEntries(request.headers)).includes("dummy-router"));
				} else {
					assert.equal(new URL(request.url).origin, "https://openrouter.ai");
					assert.equal(request.headers.get("x-openrouter-title"), metadata.name);
					assert.equal(request.headers.get("http-referer"), metadata.homepage);
					assert.equal(request.headers.get("x-session-id"), "chat_wire_exact");
				}
			}
		}));
	}

	it("native OpenAI cache keys clamp to 64 characters while affinity retains exact session", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "openai", id: "gpt-4o-mini", thinkingLevel: "off" });
		const sessionId = "chat_" + "a".repeat(70);
		let body: Record<string, unknown> = {};
		let headers = new Headers();
		globalThis.fetch = async (input, init) => { const request = new Request(input, init); headers = request.headers; body = JSON.parse(await request.text()); return new Response("{}", { status: 400, headers: { "content-type": "application/json" } }); };
		await createTeacherAgent(undefined, { engine, chatId: sessionId, tools: {} }).prompt("offline");
		assert.equal(body.prompt_cache_key, Array.from(sessionId).slice(0, 64).join(""));
		assert.equal(headers.get("session_id"), sessionId);
	}));

	it("completed malformed native JSON stays rejected despite app prepareArguments healing", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "openrouter", id: "openai/gpt-4o-mini", thinkingLevel: "off" });
		const malformed = '{"value":';
		globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ id: "offline", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_bad", type: "function", function: { name: "check", arguments: malformed } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		let executed = 0;
		let prepared = 0;
		const tools = healToolRecord({ check: { name: "check", label: "check", description: "check", parameters: Type.Object({ value: Type.Optional(Type.String()) }), execute: async () => { executed++; return { content: [], details: {} }; } } });
		const heal = tools.check!.prepareArguments!;
		tools.check!.prepareArguments = (args) => { prepared++; return heal(args); };
		const result = await runSubagent(Object.values(tools), { role: "extractor", engine, systemPrompt: "offline", prompt: "offline", maxTurns: 1 });
		const assistant = result.newMessages.find((m) => m.role === "assistant");
		assert.ok(assistant?.role === "assistant");
		const call = assistant.content.find((c) => c.type === "toolCall");
		assert.ok(call?.type === "toolCall" && call.argumentsError);
		assert.equal(executed, 0);
		assert.equal(prepared, 1, "SDK prepares arguments but preserves argumentsError for native validation");
		assert.ok(result.newMessages.some((m) => m.role === "toolResult" && m.isError));
	}));
});
