"use client";

import { useSyncExternalStore } from "react";

export type ThemeMode = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "lh-theme";
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;
let observedDark = false;

function isDarkTheme(): boolean {
	return document.documentElement.classList.contains("dark");
}
const getServerTheme = () => false;

function subscribeTheme(listener: () => void): () => void {
	themeListeners.add(listener);
	if (!themeObserver) {
		observedDark = isDarkTheme();
		themeObserver = new MutationObserver(() => {
			const dark = isDarkTheme();
			if (dark === observedDark) return;
			observedDark = dark;
			for (const notify of themeListeners) notify();
		});
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
	}
	return () => {
		themeListeners.delete(listener);
		if (themeListeners.size === 0) {
			themeObserver?.disconnect();
			themeObserver = null;
		}
	};
}

// Redesign (owner, 2026-10-27): Automatic mode can flip at sunset while
// Mermaid SVGs are mounted, so they need the live html.dark signal to repaint.
export function useIsDarkTheme(): boolean {
	return useSyncExternalStore(subscribeTheme, isDarkTheme, getServerTheme);
}


export function readThemeMode(): ThemeMode {
	try {
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		return stored === "light" || stored === "dark" ? stored : "system";
	} catch {
		return "system";
	}
}

function applyThemeMode(mode: ThemeMode): void {
	const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.classList.toggle("dark", dark);
	document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
		meta.setAttribute("content", dark ? "#243330" : "#e5d8be");
	});
}

export function saveThemeMode(mode: ThemeMode): void {
	try {
		localStorage.setItem(THEME_STORAGE_KEY, mode);
	} catch {
		// Redesign (owner, 2026-10-27): private storage may be unavailable; keep this visit's choice.
	}
	applyThemeMode(mode);
}
