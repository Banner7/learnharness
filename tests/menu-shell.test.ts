import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMenuPlacement, type MenuPlacement } from "../components/menu-shell.tsx";

// Phone popup off-screen (owner, 2026-10-28): a 352px menu right-aligned to
// the composer's model buttons (right edge 225) rendered at left -127 on a
// 390px phone. Every placement must stay 8px inside both viewport edges.
const phone = { width: 390, height: 844 };
const buttons = { top: 478, bottom: 530, left: 24, right: 225 };

function edges(placement: MenuPlacement, menuWidth: number) {
	const left = placement.style.left as number;
	const width = Math.min(menuWidth, placement.style.maxWidth as number);
	return { left, right: left + width };
}

test("a right-aligned menu wider than the room left of its anchor slides inside the viewport", () => {
	const placed = computeMenuPlacement(buttons, phone, 400, "up", "right", 352);
	assert.deepEqual(edges(placed, 352), { left: 8, right: 360 });
	assert.equal(placed.style.right, undefined, "position is keyed off left only");
});

test("a left-aligned menu near the right edge slides back left", () => {
	const anchor = { top: 100, bottom: 140, left: 300, right: 380 };
	const { left, right } = edges(computeMenuPlacement(anchor, phone, 200, "down", "left", 200), 200);
	assert.equal(right, phone.width - 8);
	assert.equal(left, phone.width - 8 - 200);
});

test("a menu wider than the viewport is capped to it", () => {
	const narrow = { width: 320, height: 640 };
	const placed = computeMenuPlacement(buttons, narrow, 400, "up", "right", 352);
	assert.equal(placed.style.maxWidth, 304);
	assert.deepEqual(edges(placed, 352), { left: 8, right: 312 });
});

test("a menu that fits keeps its preferred alignment", () => {
	const desktop = { width: 1280, height: 800 };
	const anchor = { top: 600, bottom: 640, left: 700, right: 900 };
	assert.equal(computeMenuPlacement(anchor, desktop, 300, "up", "right", 352).style.left, 900 - 352);
	assert.equal(computeMenuPlacement(anchor, desktop, 300, "up", "left", 352).style.left, 700);
});
