// Haptics (redesign, 2026-10-29): a short tap the learner feels when an
// action lands — picking an option, answering, sending.
//
// iOS: script cannot play a haptic since iOS 26.5, so iOS taps go through
// <Haptic> (components/ui/haptic.tsx), which puts a real native switch under
// the finger. tap() is the rest of the world: navigator.vibrate where it
// exists (Android). Call it from event handlers only.

/** iOS/iPadOS WebKit, where the native-switch haptic exists. */
export function iosHaptics(): boolean {
	if (typeof navigator === "undefined") return false;
	const ua = navigator.userAgent;
	return navigator.maxTouchPoints > 0 && /AppleWebKit/.test(ua) && !/Android/.test(ua);
}

/** One light vibration where the Vibration API exists; a no-op elsewhere. */
export function tap(): void {
	if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(8);
}
