/** Keyless research availability + the injected search port.
 * No network, no shared data files — the jobStore fake below is in-memory.
 * A missing search key is a recoverable tool result, not a dispatch gate.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebTools } from "../src/agent/tools/web.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ChatStore, JobStore } from "../src/core/ports.ts";
import type { JobRecord } from "../src/core/contracts.ts";
import type { SearchProvider } from "../src/core/search.ts";

describe("web_search on the injected port (web.ts)", () => {
	it("null provider → recoverable unavailability text, never a crash or native error", async () => {
		const { web_search } = createWebTools(() => null);
		const out = await web_search!.execute!("c1", { query: "anything" });
		assert.match(String(out.details), /^web_search is not available: no search engine is configured\./);
		assert.notEqual(out.isError, true, "missing keys remain ordinary recoverable text, not a native error");
	});

	it("a live provider returns its hits (count defaults to 5)", async () => {
		const seen: Array<{ query: string; count: number }> = [];
		const hits = [{ title: "sigma.js", url: "https://www.sigmajs.org/", snippet: "v3 released" }];
		const { web_search } = createWebTools(() => ({
			id: "tavily",
			async search(query, count) {
				seen.push({ query, count });
				return hits;
			},
		}));
		const out = await web_search!.execute!("c1", { query: "sigma.js latest version" });
		assert.deepEqual(seen, [{ query: "sigma.js latest version", count: 5 }]);
		assert.deepEqual(out.details, hits);
	});

	it("provider errors surface as error strings, never thrown", async () => {
		const { web_search } = createWebTools(() => ({
			id: "brave",
			async search() {
				throw new Error("Brave search API 429: rate limited");
			},
		}));
		const out = await web_search!.execute!("c1", { query: "q" });
		assert.match(String(out.details), /web_search failed: Brave search API 429: rate limited/);
	});

	it("the resolution is FRESH per call — a key appearing mid-session takes effect", async () => {
		let provider: SearchProvider | null = null;
		const { web_search } = createWebTools(() => provider);
		assert.match(String((await web_search!.execute!("c1", { query: "q" })).details), /not available/);
		provider = { id: "tavily", search: async () => [{ title: "t", url: "https://e.com/", snippet: "s" }] };
		assert.ok(Array.isArray((await web_search!.execute!("c2", { query: "q" })).details));
	});

	it("web_fetch accepts http(s) URLs and rejects others (the colon bug, 2026-10-07)", async () => {
		// URL.protocol is "https:" WITH the colon; a colon-less comparison made
		// the gate throw for every valid URL.
		const { web_fetch } = createWebTools(() => null);
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("A plain text page with enough content to matter for the test.", {
				headers: { "content-type": "text/plain" },
			})) as typeof fetch;
		try {
			assert.match(String((await web_fetch!.execute!("c-ok", { url: "https://example.com/page" })).details), /plain text page/);
			assert.match(String((await web_fetch!.execute!("c-ftp", { url: "ftp://example.com/file" })).details), /invalid URL/);
			assert.match(String((await web_fetch!.execute!("c-bad", { url: "not a url" })).details), /web_fetch failed: invalid URL/);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("web_fetch refuses private destinations, including via redirect (SSRF)", async () => {
		const { web_fetch } = createWebTools(() => null);
		const realFetch = globalThis.fetch;
		const fetched: string[] = [];
		globalThis.fetch = (async (input) => {
			fetched.push(String(input));
			return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8384/rest/config" } });
		}) as typeof fetch;
		try {
			for (const url of [
				"http://127.0.0.1:8222/admin",
				"http://localhost:7318/",
				"http://[::1]/",
				"http://[::ffff:10.0.0.1]/",
				"http://100.101.102.103/",
				"http://169.254.169.254/latest/meta-data/",
				"http://172.18.0.2/",
			]) {
				assert.match(String((await web_fetch!.execute!("c-priv", { url })).details), /private address/, url);
			}
			assert.deepEqual(fetched, [], "no private URL reaches fetch");
			const out = String((await web_fetch!.execute!("c-redir", { url: "http://93.184.215.14/" })).details);
			assert.match(out, /private address/);
			assert.deepEqual(fetched, ["http://93.184.215.14/"], "the redirect target is never fetched");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("keyless researcher loop", () => {
	// The script proves tool/loop mechanics, not real-model compliance.
	it("recovers from missing search keys by fetching a supplied URL", async () => {
		const url = "https://example.com/supplied-source";
		const brief = `## Summary\nVerified supplied source. [Source](${url})`;
		const faux = createFauxCore({});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "supplied source" }, { id: "search1" })], { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "search1");
				assert.ok(result && result.role === "toolResult");
				assert.equal(result.isError, false, "missing keys do not abort the native loop");
				assert.match(JSON.stringify(result.content), /no search engine is configured/);
				return fauxAssistantMessage([fauxToolCall("web_fetch", { url }, { id: "fetch1" })], { stopReason: "toolUse" });
			},
			(context) => {
				const result = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "fetch1");
				assert.ok(result && result.role === "toolResult");
				assert.match(JSON.stringify(result.content), /Synthetic verified source content/);
				return fauxAssistantMessage([fauxText(brief)]);
			},
		]);
		const realFetch = globalThis.fetch;
		const fetched: string[] = [];
		globalThis.fetch = (async (input) => {
			fetched.push(String(input));
			return new Response("Synthetic verified source content", { headers: { "content-type": "text/plain" } });
		}) as typeof fetch;
		try {
			assert.equal(await runResearcherAgent(`Verify ${url}`, {
				engine: { model: faux.getModel(), streamFn: faux.streamSimple },
			}), brief);
			assert.deepEqual(fetched, [url], "only the supplied URL is fetched");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

/** Minimal in-memory JobStore — registry tests never touch the fs. */
function fakeJobStore(): JobStore {
	const jobs = new Map<string, JobRecord>();
	return {
		createJob(init) {
			const job = {
				id: `job_${jobs.size + 1}`,
				kind: init.kind,
				chatId: init.chatId,
				toolCallId: init.toolCallId,
				status: "running",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				activity: "",
			} as JobRecord;
			jobs.set(job.id, job);
			return job;
		},
		getJob: (id) => jobs.get(id) ?? null,
		updateJob: (id, patch) => {
			const job = jobs.get(id);
			return job ? Object.assign(job, patch) : null;
		},
		listJobs: () => [...jobs.values()],
		findJobByToolCallId: () => null,
		deleteJobsForChat: () => 0,
	};
}

const fakeChatStore = { getChat: () => null, saveMessages: () => {} } as unknown as ChatStore;

describe("keyless research dispatch", () => {
	it("keyless dispatch preserves the async job acknowledgement and spawn contract", async () => {
		const spawned: Array<{ job: JobRecord; input: unknown }> = [];
		const tools = jobTools({
			chatId: "chat-drop-test",
			jobStore: fakeJobStore(),
			spawn: (job, input) => { spawned.push({ job, input }); },
			searchAvailable: () => false,
		});
		const input = { question: "Verify the supplied URL", context: "https://example.com/source" };
		const out = await tools.research!.execute!("keyless-call", input);
		assert.match(String(out.details), /^Dispatched \(job job_1\)\./);
		assert.equal(spawned.length, 1);
		assert.equal(spawned[0]!.job.kind, "research");
		assert.equal(spawned[0]!.job.toolCallId, "keyless-call");
		assert.deepEqual(spawned[0]!.input, input);
	});

	it("role registries keep research without search keys; only the user toggle drops it", () => {
		const ctx = { chatId: "chat-gate-test", chatStore: fakeChatStore, jobStore: fakeJobStore(), spawn: () => {}, searchAvailable: () => false };
		assert.ok(createTeacherTools(ctx).research);
		const prober = createProberTools({ ...ctx, deliver: () => {} });
		assert.ok(prober.research && prober.pdf && prober.probe_done);
		const teacherOff = createTeacherTools(ctx, { research: false });
		assert.equal("research" in teacherOff, false);
		assert.ok(teacherOff.pdf && teacherOff.demo && teacherOff.visual);
		const proberOff = createProberTools({ ...ctx, deliver: () => {} }, { research: false });
		assert.equal("research" in proberOff, false);
		assert.ok(proberOff.pdf, "pdf unaffected by a research toggle");
	});
});
