"use client";
/**
 * Theme switch beside Settings (owner, 2026-10-31): Automatic / Light /
 * Dark one tap away instead of inside Settings → Appearance. Same device
 * storage (lib/theme-mode), so the Appearance radio group agrees with it.
 */

import { useEffect, useState } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { readThemeMode, saveThemeMode, type ThemeMode } from "@/lib/theme-mode";
import { Hint } from "@/components/ui/hint";

const MODES: { mode: ThemeMode; label: string; Icon: typeof SunIcon }[] = [
	{ mode: "system", label: "Automatic", Icon: MonitorIcon },
	{ mode: "light", label: "Light", Icon: SunIcon },
	{ mode: "dark", label: "Dark", Icon: MoonIcon },
];

export function ThemeToggle({ side = "bottom" }: { side?: "top" | "bottom" | "left" | "right" }) {
	const [current, setCurrent] = useState<ThemeMode>("system");
	// The pre-paint script owns the initial mode; mount only syncs the control.
	useEffect(() => setCurrent(readThemeMode()), []);
	return (
		<div role="radiogroup" aria-label="Theme" data-testid="theme-toggle" className="flex items-center rounded-md bg-muted p-0.5">
			{MODES.map(({ mode, label, Icon }) => (
				<Hint key={mode} label={label} side={side}>
					<button
						type="button"
						role="radio"
						aria-checked={current === mode}
						aria-label={label}
						onClick={() => {
							setCurrent(mode);
							saveThemeMode(mode);
						}}
						className={`flex size-8 items-center justify-center rounded-md transition-colors ${current === mode ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"}`}
					>
						<Icon className="size-3.5" />
					</button>
				</Hint>
			))}
		</div>
	);
}
