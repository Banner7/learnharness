/**
 * Session-row render tests — the picker's status language (owner,
 * minimal-color round): ONE indicator, the braille spinner, present ONLY
 * while a turn is in flight; every other state renders nothing and the
 * meta line's text carries it. Pure function of the list item, so SSR of
 * <SessionRow> pins every visible state.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRow, timeAgo } from "../components/sidebar.tsx";
import type { ChatListItem } from "../src/core/index.ts";

function item(overrides: Partial<ChatListItem>): ChatListItem {
	return {
		id: "c1",
		title: "Test session",
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 4,
		phase: "probe",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}

function render(chat: ChatListItem, dated?: boolean) {
	return renderToStaticMarkup(<SessionRow chat={chat} active={false} dated={dated} onOpen={() => {}} />);
}

describe("SessionRow", () => {
	it("the spinner shows ONLY while a turn is in flight", () => {
		assert.ok(render(item({ busy: true })).includes('data-testid="braille-spinner"'));
		for (const chat of [item({ phase: "teach" }), item({ pendingQuestion: true }), item({ kind: "practice", pendingProblem: true })]) {
			assert.ok(!render(chat).includes("braille-spinner"));
		}
	});

	it("the meta line: state replaces the date's neighbors — compacting > waiting > idle date", () => {
		for (const kind of ["teach", "practice"] as const) {
			for (const updatedAt of [new Date().toISOString(), "2025-06-02T12:00:00.000Z"]) {
				assert.ok(render(item({ kind, pendingQuestion: true, updatedAt })).includes(`Waiting for input, ${timeAgo(updatedAt)}`));
			}
		}
		const compacting = render(item({ compacting: true, pendingQuestion: true }));
		assert.match(compacting, /Compacting context,/);
		assert.doesNotMatch(compacting, /Waiting for input/);
		assert.match(render(item({ busy: true })), /Working…/);
		assert.match(render(item({ kind: "practice", busy: true })), /Working…/);
		assert.match(render(item({ kind: "practice", pendingProblem: true })), /Problem waiting,/);
		assert.match(render(item({})), /\d{4}-\d{2}-\d{2}/, "idle shows the date");
	});

	it("in a day-grouped list the date drops but a state still shows (redesign 2026-10-29)", () => {
		assert.doesNotMatch(render(item({ updatedAt: "2026-01-02T01:00:00.000Z" }), false), /\d{4}-\d{2}-\d{2}|ago|just now/);
		assert.match(render(item({ pendingQuestion: true }), false), />Waiting for input</);
		assert.match(render(item({ compacting: true }), false), />Compacting context</);
		assert.match(render(item({ kind: "practice", pendingProblem: true }), false), />Problem waiting</);
	});

	it("practice rows carry the practice badge; teaching rows do not", () => {
		assert.match(render(item({ kind: "practice" })), /aria-label="Practice session"/);
		assert.doesNotMatch(render(item({})), /Practice session/);
	});
});

describe("timeAgo", () => {
	const now = new Date("2026-01-02T12:00:00.000Z");

	it("just now / minutes / hours / days, then the ISO date; clock skew reads as just now", () => {
		assert.equal(timeAgo("2026-01-02T11:59:30.000Z", now), "just now");
		assert.equal(timeAgo("2026-01-02T11:55:00.000Z", now), "5m ago");
		assert.equal(timeAgo("2026-01-02T09:00:00.000Z", now), "3h ago");
		assert.equal(timeAgo("2025-12-31T12:00:00.000Z", now), "2d ago");
		assert.equal(timeAgo("2025-06-02T12:00:00.000Z", now), "2025-06-02");
		assert.equal(timeAgo("2026-01-02T12:01:00.000Z", now), "just now");
	});
});
