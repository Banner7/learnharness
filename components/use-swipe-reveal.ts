import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

const REVEAL_WIDTH = 80;
const DIRECTION_THRESHOLD = 10;

type Gesture = {
	pointerId: number;
	startX: number;
	startY: number;
	startOffset: number;
	direction: "undecided" | "horizontal" | "vertical";
};

/** Keep native vertical scrolling while a horizontal touch/pen drag reveals an action. */
export function useSwipeReveal(open: boolean, onOpenChange: (open: boolean) => void) {
	const [dragOffset, setDragOffset] = useState<number | null>(null);
	const gesture = useRef<Gesture | null>(null);
	const suppressClick = useRef(false);
	const clearSuppressionTimer = useRef<number | undefined>(undefined);
	useEffect(() => () => {
		clearTimeout(clearSuppressionTimer.current);
	}, []);
	const offset = dragOffset ?? (open ? -REVEAL_WIDTH : 0);

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		// A pan may not emit a click; its suppression belongs only to that pointer sequence.
		clearTimeout(clearSuppressionTimer.current);
		clearSuppressionTimer.current = undefined;
		suppressClick.current = false;
		if ((event.pointerType !== "touch" && event.pointerType !== "pen") || !event.isPrimary) return;
		gesture.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			startOffset: open ? -REVEAL_WIDTH : 0,
			direction: "undecided",
		};
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = gesture.current;
		if (!current || current.pointerId !== event.pointerId || current.direction === "vertical") return;
		const dx = event.clientX - current.startX;
		const dy = event.clientY - current.startY;
		if (current.direction === "undecided") {
			if (Math.abs(dx) <= DIRECTION_THRESHOLD && Math.abs(dy) <= DIRECTION_THRESHOLD) return;
			current.direction = Math.abs(dx) > DIRECTION_THRESHOLD && Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
			if (current.direction === "vertical") return;
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		suppressClick.current = true;
		setDragOffset(Math.max(-REVEAL_WIDTH, Math.min(0, current.startOffset + dx)));
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = gesture.current;
		if (!current || current.pointerId !== event.pointerId) return;
		if (current.direction === "horizontal") {
			const dx = event.clientX - current.startX;
			const finalOffset = Math.max(-REVEAL_WIDTH, Math.min(0, current.startOffset + dx));
			onOpenChange(finalOffset <= -REVEAL_WIDTH / 2);
			// Native click follows pointerup immediately if one is emitted; otherwise
			// discard the flag rather than swallowing a later, unrelated tap.
			clearSuppressionTimer.current = window.setTimeout(() => {
				suppressClick.current = false;
				clearSuppressionTimer.current = undefined;
			}, 50);
		}
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		gesture.current = null;
		setDragOffset(null);
	};

	const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (gesture.current?.pointerId !== event.pointerId) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		gesture.current = null;
		suppressClick.current = false;
		setDragOffset(null);
	};

	/** A released swipe may emit a click; it must never navigate. */
	const consumeSwipeClick = (event: ReactMouseEvent<HTMLElement>) => {
		if (!suppressClick.current || event.detail === 0) return false;
		suppressClick.current = false;
		event.preventDefault();
		return true;
	};

	return {
		offset,
		dragging: dragOffset !== null,
		revealed: offset < 0,
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onPointerCancel,
		consumeSwipeClick,
	};
}
