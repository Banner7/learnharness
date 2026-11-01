/**
 * Chat store events: list-shape writes (create/rename/delete) announce
 * chats-changed, which drives the sidebar. Isolated LH_DATA_DIR, set before
 * any config-loading import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-store-events-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { subscribe } = await import("../src/core/events.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("chat store events", () => {
	it("createChat, renameChat, deleteChat each announce chats-changed", () => {
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "chats-changed") announces++;
		});

		const chat = chatStore.createChat("Store events fixture");
		assert.equal(announces, 1, "create announces post-write");

		chatStore.renameChat(chat.id, "Renamed");
		assert.equal(announces, 2, "rename announces (a list-shape write)");

		assert.equal(chatStore.deleteChat(chat.id), true);
		assert.equal(announces, 3, "a real delete announces");
		off();
	});
});
