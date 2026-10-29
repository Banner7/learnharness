"use client";

/**
 * Shared top bar for phone pages and full-bleed sheets. It includes the
 * sidebar drawer button; consumers provide a title and optional actions.
 * Safe-area padding clears the device status bar.
 */

import type { ReactNode } from "react";
import { SidebarToggle } from "@/components/sidebar";

export function TopBar({
	onMouseDown,
	children,
}: {
	onMouseDown?: React.MouseEventHandler<HTMLElement>;
	children?: ReactNode;
}) {
	return (
		<header
			onMouseDown={onMouseDown}
			className="flex h-[calc(4rem+env(safe-area-inset-top))] select-none items-center gap-2 border-b border-border bg-background px-3 pt-[env(safe-area-inset-top)] [&_h1]:font-title [&_h2]:font-title [&_button]:min-h-11"
		>
			<SidebarToggle />
			{children}
		</header>
	);
}
