/**
 * THE GRAPH-CONTEXT MARKER (owner, 2026-10-04 late): a session started
 * with map picks gets its context as a SEPARATE custom message BEFORE
 * the learner's first user message — the picked propositions plus the
 * reasoning chains among them. The model reads the marker's content
 * (toLlmMessages flattens it to a user message); `details` feeds the
 * transcript's GraphContextCard.
 *
 * The route pin drives POST /api/chats under an isolated LH_DATA_DIR
 * (the birth-stamp discipline: every app-module import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-graph-context-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { newGraphContextMessage, toLlmMessages } = await import("../src/core/native-messages.ts");
import type { LhMessage } from "../src/core/native-messages.ts";
const { projectView } = await import("../src/core/view.ts");
const { POST } = await import("../server/routes/chats/route.ts");
const { initialPromptOwed } = await import("../components/chat.tsx");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const PICKS = [
	{ id: "n_a", name: "Modus ponens", statement: "If P implies Q and P holds, Q holds." },
	{ id: "n_b", name: "Soundness", statement: "A valid argument from true premises has a true conclusion." },
];

function postChat(body: unknown): Promise<Response> {
	return POST(new Request("http://test/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}));
}

describe("newGraphContextMessage", () => {
	it("the model reads ids-first picks and the chains; the UI gets the structured pick", () => {
		const m = newGraphContextMessage(PICKS, ["Modus ponens → Soundness"]);
		assert.equal(m.customType, "graph-context");
		// IDS FIRST (owner round 9): the problem tool's target field references these.
		assert.ok(m.content.includes(`[${PICKS[0]!.id}] Modus ponens: If P implies Q and P holds, Q holds.`));
		assert.ok(m.content.includes("- Modus ponens → Soundness"));
		assert.deepEqual(m.details, { propositions: PICKS, chains: ["Modus ponens → Soundness"] });
		assert.ok(!newGraphContextMessage(PICKS, []).content.includes("Reasoning chains"), "no chains: the section stays out");

		const wire = toLlmMessages([m as unknown as LhMessage] as never);
		assert.equal(wire.length, 1);
		assert.equal(wire[0]!.role, "user");
		assert.ok(String((wire[0]!.content as { text?: string }[])[0]!.text).includes("[n_a] Modus ponens"));

		const view = projectView([m as unknown as LhMessage] as never);
		assert.equal(view[0]!.role, "user");
		assert.equal((view[0]!.parts[0] as { type: string }).type, "data-graph-context", "a data part — never a text bubble");
		assert.deepEqual((view[0]!.parts[0] as { data: unknown }).data, m.details);
	});
});

// The dead first turn (owner report 2026-10-04): scaffolding is not conversation.
describe("initialPromptOwed", () => {
	it("a marker-only record still owes the prompt; any user/assistant message spends it; no prompt owes nothing", () => {
		const marker = newGraphContextMessage(PICKS, []) as never;
		assert.equal(initialPromptOwed([marker], "drill me on logic"), true);
		assert.equal(initialPromptOwed([marker, { role: "user" } as never], "drill me"), false);
		assert.equal(initialPromptOwed([{ role: "assistant" } as never], "drill me"), false);
		assert.equal(initialPromptOwed([], undefined), false);
	});
});

describe("POST /api/chats — graphContext becomes message[0]", () => {
	it("writes the marker before any user message; chains derive from the live graph", async () => {
		const node = (id: string, name: string, statement: string) => ({
			id, name, statement, aliases: [] as string[], createdAt: "2026-10-01T00:00:00.000Z", provenance: [],
		});
		graphStore.appendNode(node("n_a", "Modus ponens", "If P implies Q and P holds, Q holds."));
		graphStore.appendNode(node("n_b", "Soundness", "A valid argument from true premises has a true conclusion."));
		graphStore.appendChain({ id: "arg_1", premises: ["n_a"], conclusion: "n_b", provenance: [], createdAt: "2026-10-01T00:00:00.000Z" });

		const res = await postChat({ title: "drill me on logic", kind: "practice", graphContext: { propositions: PICKS } });
		assert.equal(res.status, 200);
		const { id } = (await res.json()) as { id: string };
		const record = chatStore.getChat(id)!;
		assert.equal(record.messages.length, 1, "the marker is message[0], alone until the first turn");
		const m = record.messages[0] as { role: string; customType: string; content: string };
		assert.equal(m.role, "custom");
		assert.equal(m.customType, "graph-context");
		assert.ok(m.content.includes("[n_a] Modus ponens"));
		assert.ok(m.content.includes("- Modus ponens → Soundness"), "the chain AMONG the picks rides the marker");
	});

	it("no picks (or malformed) → no marker, an empty record", async () => {
		for (const body of [{ title: "t" }, { title: "t", graphContext: { propositions: "junk" } }]) {
			const { id } = (await (await postChat(body)).json()) as { id: string };
			assert.equal(chatStore.getChat(id)!.messages.length, 0);
		}
	});
});
