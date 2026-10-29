"use client";

import { useState } from "react";
import { iosHaptics } from "@/lib/haptics";

/* Haptics on iOS (fork, 2026-10-29; third try, owner-tested on device).
   Since iOS 26.5 a switch toggled from script plays no haptic, and a native
   switch under the finger blocks scrolling (WebKit bug 321591). What the
   owner felt in both Safari-engine browsers and the home-screen app: a
   transparent <label> over the button, wired to a hidden native switch
   (the ios-haptics technique, github.com/tijnjh/ios-haptics). The finger's
   tap on the label is a real tap, the label forwards it to the switch, and
   iOS plays the system tick; the switch never sits under the finger, so
   scrolling from the button still works. The tap still reaches the button
   (its onClick runs, and a submit button still submits); the switch's
   forwarded copy is stopped so the button's handler runs once.
   Render it as the LAST child of a `relative` button. iOS only. */
export function HapticLabel() {
	const [enabled] = useState(iosHaptics);
	if (!enabled) return null;
	return (
		<label
			aria-hidden
			className="absolute inset-0 touch-manipulation [-webkit-tap-highlight-color:transparent]"
		>
			<input
				type="checkbox"
				{...{ switch: "" }}
				tabIndex={-1}
				onClick={(event) => event.stopPropagation()}
				className="invisible absolute m-0 size-px"
			/>
		</label>
	);
}
