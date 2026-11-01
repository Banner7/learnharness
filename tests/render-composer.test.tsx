import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../components/composer.tsx";

function render(
	opts: { busy?: boolean; canSend?: boolean; nextProblem?: boolean } = {},
) {
	return renderToStaticMarkup(
		<Composer
			busy={opts.busy ?? false}
			value=""
			onChange={() => {}}
			onSend={() => {}}
			onStop={() => {}}
			canSend={opts.canSend ?? true}
			{...(opts.nextProblem ? { nextProblem: true, onNext: () => {} } : {})}
		/>,
	);
}

describe("Composer", () => {
	it("busy with text: the button STAYS Send (click = steer); busy and empty: it becomes Stop", () => {
		const steering = render({ busy: true, canSend: true });
		assert.ok(steering.includes('aria-label="Send"'), "the steer affordance is clickable mid-turn");
		assert.ok(!steering.includes('aria-label="Stop"'), "no morph while there is text to steer with");
		const idleStop = render({ busy: true, canSend: false });
		assert.ok(idleStop.includes('aria-label="Stop"'), "empty composer: stop replaces send while streaming");
	});

	it("disabled when nothing to send", () => {
		const html = render({ canSend: false });
		assert.ok(/aria-label="Send"[^>]*disabled|disabled[^>]*aria-label="Send"/.test(html), "send disabled");
	});

	it("THE NEXT MORPH (owner round 16 refinement): empty composer in the pause → wide Next problem", () => {
		const html = render({ canSend: false, nextProblem: true });
		assert.ok(html.includes('data-testid="next-problem-button"'), "the morphed button");
		assert.match(html, /Next problem/, "the label");
		assert.ok(!html.includes('aria-label="Send"'), "the square send is gone in the pause");
	});

	it("typing anything returns the regular send button (canSend outranks the morph)", () => {
		const html = render({ canSend: true, nextProblem: true });
		assert.ok(html.includes('aria-label="Send"'), "regular send while there is text");
		assert.ok(!html.includes('data-testid="next-problem-button"'), "no next morph with text typed");
	});

	it("busy outranks the morph — stop stays reachable", () => {
		const html = render({ busy: true, canSend: false, nextProblem: true });
		assert.ok(html.includes('aria-label="Stop"'), "stop wins the empty lane mid-turn");
		assert.ok(!html.includes('data-testid="next-problem-button"'), "no next morph mid-turn");
	});
});
