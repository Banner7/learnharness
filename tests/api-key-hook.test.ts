/**
 * The getApiKey-hook fix (owner, 2026-09-26): a provided getApiKey hook
 * OVERRIDES pi-ai's native per-provider env resolution, and the old hook
 * always returned the OpenRouter key, so every other provider 401'd. The fix
 * is deletion: built agents must expose NO getApiKey hook.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberAgent, createTeacherAgent, type TeachingAgent } from "../src/agent/teacher-agent.ts";
import type { ProberToolContext } from "../src/agent/tools.ts";
import { jobStore } from "../src/store/jobs.ts";
import { chatStore } from "../src/store/chats.ts";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

/** A scripted pi engine — the agent builds need an injected engine since
 * BYOK removed the factory pins (owner, 2026-09-22). */
function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

describe("the getApiKey-hook fix (native per-provider key resolution)", () => {
	it("teacher and prober builds expose NO getApiKey hook — pi-ai resolves keys natively", () => {
		const chatId = chatStore.createChat("getApiKey pin").id;
		const ctx: ProberToolContext = { chatId, chatStore, deliver: () => {}, jobStore, spawn: () => {} };
		const builds: TeachingAgent[] = [
			createTeacherAgent(undefined, { engine: fauxEngine() }),
			createProberAgent(ctx, { engine: fauxEngine() }),
		];
		for (const agent of builds) {
			assert.equal(
				(agent as unknown as { getApiKey?: unknown }).getApiKey,
				undefined,
				"the OpenRouter-pinning hook must stay deleted — a set hook overrides pi-ai's native per-provider env resolution for EVERY provider",
			);
		}
	});
});