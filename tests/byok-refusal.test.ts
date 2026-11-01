import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelsRefusal, parseProviderKeyRefusal, retryFailedResponse } from "../components/chat.tsx";
import { SessionModel } from "../components/session-core.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import {
	isModelsRefusal,
	isProviderKeyRefusal,
	modelsNotConfigured,
	providerKeyMissing,
	PROVIDER_KEY_MISSING_CODE,
} from "../src/core/settings.ts";

/**
 * The BYOK universal gate rendered honestly (owner, 2026-09-22): the server
 * refuses turns with 503 envelopes (models_not_configured /
 * provider_key_missing). These pin the client's refusal detectors (the
 * transport throws the 503 body verbatim as the error text) and the
 * job-record refusal matchers.
 */

const REFUSAL = JSON.stringify(modelsNotConfigured(["strong"]));
const KEY_REFUSAL = JSON.stringify(providerKeyMissing("openrouter", ["strong"]));

describe("send refusal detectors", () => {
	it("parseModelsRefusal reads the missing tiers; anything else is a real error", () => {
		assert.deepEqual(parseModelsRefusal(JSON.stringify(modelsNotConfigured(["strong", "vision"]))), ["strong", "vision"]);
		for (const text of [
			undefined,
			"Something went wrong",
			'{"error":"A turn is already running"}',
			'{"code":"models_not_configured","missing":"strong"}',
			'{"code":"models_not_configured","missing":[42]}',
			KEY_REFUSAL,
		]) {
			assert.equal(parseModelsRefusal(text), null, String(text));
		}
	});

	it("parseProviderKeyRefusal reads the envelope's own code; anything else is a real error", () => {
		assert.equal(parseProviderKeyRefusal(KEY_REFUSAL), true);
		assert.equal(parseProviderKeyRefusal(JSON.stringify(providerKeyMissing("anthropic", ["strong", "vision"]))), true);
		for (const text of [REFUSAL, "FAILED: headless crashed", undefined, "{not json"]) {
			assert.equal(parseProviderKeyRefusal(text), false, String(text));
		}
	});
});

describe("Retry owns no composer recovery draft", () => {
	for (const envelope of [providerKeyMissing("openrouter", ["strong"]), modelsNotConfigured(["strong"])]) {
		it(`accepted A / failed model / unsent B / Retry ${envelope.code} retires only A's fallback`, async () => {
			const durable: LhMessage[] = [
				newUserMessage("Accepted text A"),
				{ ...fauxAssistantMessage("Partial reply", { stopReason: "error", errorMessage: "Model failed" }), id: "failed-A" },
			];
			const submittedDraft: { current: string | null } = { current: "Accepted text A" };
			let composer = "Unsent text B";
			const body = JSON.stringify(envelope);
			const model = new SessionModel({
				chatId: "fixture", initialMessages: durable,
				fetch: async (_url, init) => {
					assert.equal(submittedDraft.current, null, "retire A before Retry can reach a refusal");
					assert.deepEqual(JSON.parse(String(init?.body)).input, { type: "retry" });
					return new Response(body, { status: 503 });
				},
			});
			let request!: ReturnType<SessionModel["send"]>;
			retryFailedResponse((input) => request = model.send(input), submittedDraft);
			await request;
			assert.equal(model.getState().error?.message, body, "503 stays raw for existing setup/picker routing");
			// The refusal effect restores only an owned submitted draft.
			if (submittedDraft.current !== null) composer = submittedDraft.current;
			assert.equal(composer, "Unsent text B");
			assert.deepEqual(model.getState().nativeMessages, durable, "Retry adds no optimistic learner message");
		});
	}

	it("does not clear a later ordinary send's recovery draft when Retry settles", async () => {
		const submittedDraft: { current: string | null } = { current: "Accepted text A" };
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => { finish = resolve; });
		retryFailedResponse(async () => pending, submittedDraft);
		assert.equal(submittedDraft.current, null);
		submittedDraft.current = "Later ordinary text C";
		finish();
		await pending;
		await Promise.resolve();
		assert.equal(submittedDraft.current, "Later ordinary text C", "no asynchronous cleanup may retire a newer owner");
	});

	it("ordinary text refusals still keep their submitted draft for recovery", async () => {
		const submittedDraft: { current: string | null } = { current: "Ordinary text C" };
		const model = new SessionModel({
			chatId: "fixture", initialMessages: [],
			fetch: async () => new Response(KEY_REFUSAL, { status: 503 }),
		});
		await model.send({ type: "text", text: submittedDraft.current! });
		assert.equal(submittedDraft.current, "Ordinary text C");
		assert.equal(model.getState().error?.message, KEY_REFUSAL);
	});
});

describe("providerKeyMissing + job-record matchers", () => {
	it("the envelope names the provider (raw id when unknown) and carries the exact machine code", () => {
		assert.deepEqual(providerKeyMissing("openrouter", ["strong"]), {
			error: "No OpenRouter credential is configured — configure it on the server",
			code: PROVIDER_KEY_MISSING_CODE,
			provider: "openrouter",
			slots: ["strong"],
		});
		assert.equal(PROVIDER_KEY_MISSING_CODE, "provider_key_missing");
		assert.match(providerKeyMissing("weird", ["cheap"]).error, /^No weird credential/);
	});

	it("each matcher recognizes only its own refusal, never real failures", () => {
		assert.equal(isModelsRefusal(`${modelsNotConfigured(["vision"]).error} (missing: vision)`), true);
		assert.equal(isModelsRefusal(modelsNotConfigured(["cheap"]).error), true);
		assert.equal(isProviderKeyRefusal(providerKeyMissing("together", ["cheap"]).error), true);
		assert.equal(isProviderKeyRefusal(modelsNotConfigured(["strong"]).error), false);
		for (const text of [undefined, "", "FAILED: headless crashed"]) {
			assert.equal(isModelsRefusal(text), false);
			assert.equal(isProviderKeyRefusal(text), false);
		}
	});
});
