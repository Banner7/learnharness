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
 * refuses ALL turns with 503 {error, code: "models_not_configured", missing}
 * when a slot tier is unset. These pin the client's pure seams: the refusal
 * detector (the transport throws the 503 body verbatim as the error text)
 * and the job-record refusal matcher.
 */

const REFUSAL = JSON.stringify(modelsNotConfigured(["strong"]));

describe("parseModelsRefusal — the send refusal detector", () => {
	it("reads the missing tiers from the envelope text", () => {
		assert.deepEqual(parseModelsRefusal(REFUSAL), ["strong"]);
		assert.deepEqual(parseModelsRefusal(JSON.stringify(modelsNotConfigured(["strong", "vision"]))), [
			"strong",
			"vision",
		]);
	});

	it("anything else is a real error — null, the honest banner stays", () => {
		assert.equal(parseModelsRefusal(undefined), null);
		assert.equal(parseModelsRefusal("Something went wrong"), null); // not JSON
		assert.equal(parseModelsRefusal('{"error":"A turn is already running"}'), null); // JSON, wrong code
		assert.equal(parseModelsRefusal('{"code":"models_not_configured","missing":"strong"}'), null); // missing not an array
		assert.equal(parseModelsRefusal('{"code":"models_not_configured","missing":[42]}'), null); // tiers are strings
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
			assert.ok(parseModelsRefusal(body) || parseProviderKeyRefusal(body));
			// The existing refusal effect restores only an owned submitted
			// draft. Retry must leave this slot empty, not replace B with A.
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
		const body = JSON.stringify(providerKeyMissing("openrouter", ["strong"]));
		const model = new SessionModel({
			chatId: "fixture", initialMessages: [],
			fetch: async () => new Response(body, { status: 503 }),
		});
		await model.send({ type: "text", text: submittedDraft.current! });
		assert.equal(submittedDraft.current, "Ordinary text C");
		assert.equal(model.getState().error?.message, body);
		assert.equal(parseProviderKeyRefusal(model.getState().error?.message), true);
	});
});

describe("isModelsRefusal — the job-record matcher", () => {
	it("matches the runner's composed wording, not real failures", () => {
		assert.equal(isModelsRefusal(`${modelsNotConfigured(["vision"]).error} (missing: vision)`), true);
		assert.equal(isModelsRefusal(modelsNotConfigured(["cheap"]).error), true);
		assert.equal(isModelsRefusal(undefined), false);
		assert.equal(isModelsRefusal("FAILED: headless crashed"), false);
	});
});

describe("providerKeyMissing — the envelope factory (provider-key interlude, 2026-09-25)", () => {
	it("names the provider from the curated label and carries the exact machine code", () => {
		const envelope = providerKeyMissing("openrouter", ["strong"]);
		assert.deepEqual(envelope, {
			error: "No OpenRouter credential is configured — configure it on the server",
			code: PROVIDER_KEY_MISSING_CODE,
			provider: "openrouter",
			slots: ["strong"],
		});
		assert.equal(envelope.code, "provider_key_missing");
	});

	it("an unknown provider falls back to its raw id as the label", () => {
		const envelope = providerKeyMissing("weird", ["cheap"]);
		assert.equal(envelope.error, "No weird credential is configured — configure it on the server");
	});
});

describe("parseProviderKeyRefusal — the send refusal detector's twin (zero-keys wave)", () => {
	it("reads the envelope's own code + invariant tail — the wording can never drift client-side", () => {
		const REFUSED = JSON.stringify(providerKeyMissing("openrouter", ["strong"]));
		assert.equal(parseProviderKeyRefusal(REFUSED), true);
		assert.equal(parseProviderKeyRefusal(JSON.stringify(providerKeyMissing("anthropic", ["strong", "vision"]))), true);
	});

	it("anything else is a real error — false, the honest banner stays", () => {
		assert.equal(parseProviderKeyRefusal(REFUSAL), false); // the models refusal is NOT this one
		assert.equal(parseProviderKeyRefusal("FAILED: headless crashed"), false);
		assert.equal(parseProviderKeyRefusal(undefined), false);
		assert.equal(parseProviderKeyRefusal("{not json"), false);
	});
});

describe("isProviderKeyRefusal — the job-record matcher (provider-key interlude)", () => {
	it("matches the envelope wording regardless of provider label, not real failures", () => {
		assert.equal(isProviderKeyRefusal(providerKeyMissing("together", ["cheap"]).error), true);
		assert.equal(isProviderKeyRefusal(providerKeyMissing("openai", ["strong"]).error), true);
		assert.equal(isProviderKeyRefusal(""), false);
		assert.equal(isProviderKeyRefusal(undefined), false);
		assert.equal(isProviderKeyRefusal("FAILED: headless crashed"), false);
		assert.equal(isProviderKeyRefusal(modelsNotConfigured(["strong"]).error), false, "the models refusal is a different failure");
	});
});

