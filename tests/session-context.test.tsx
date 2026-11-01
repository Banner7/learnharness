import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RenameRow } from "../components/sidebar.tsx";
import { DeleteSessionBody, DeleteSessionDialog, TRACES_COPY } from "../components/delete-session-dialog.tsx";
import type { ChatListItem } from "../src/core/index.ts";

/**
 * Wave 6 chunk A — the sidebar's inline RenameRow and the delete dialog's
 * preserve-graph default.
 */

const chat: ChatListItem = {
	id: "c1",
	title: "Wave mechanics",
	updatedAt: new Date().toISOString(),
	busy: false,
} as unknown as ChatListItem;

describe("RenameRow — the inline rename surface", () => {
	it("the controlled draft starts from the current title", () => {
		const html = renderToStaticMarkup(<RenameRow chat={chat} onCommit={() => {}} onCancel={() => {}} />);
		assert.ok(html.includes(`value="${chat.title}"`));
	});
});

describe("DeleteSessionDialog — the node-dialog shape (owner flow rework 2026-09-24; portals no-op in SSR; pin the pure body)", () => {
	it("closed (chat=null) renders nothing", () => {
		const html = renderToStaticMarkup(
			<DeleteSessionDialog chat={null} onClose={() => {}} onDeleted={() => {}} />,
		);
		assert.equal(html, "");
	});

	const body = (traces: boolean, busy: boolean) =>
		renderToStaticMarkup(
			<DeleteSessionBody chat={{ id: "c1", title: "Orbital mechanics" }} traces={traces} busy={busy} failure={null} onTraces={() => {}} onClose={() => {}} onRun={() => {}} />,
		);

	it("names the session; the graph-traces checkbox is unchecked by default (preserve-graph)", () => {
		const html = body(false, false);
		assert.match(html, /data-testid="session-name-code"[^>]*>Orbital mechanics</);
		// React SSR omits the attribute when false, so pin its ABSENCE
		assert.ok(!/"checked"/.test(html), "unchecked by default");
		assert.ok(html.includes(TRACES_COPY.title));
	});

	it("a busy render keeps the checkbox (disabled, not unmounted)", () => {
		assert.match(body(true, true), /data-testid="delete-traces-checkbox"[^>]*disabled=""/);
	});
});