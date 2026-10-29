"use client"

import * as React from "react"
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

/** Tooltip composition for icon and pill controls. */

interface HintProps {
	label: string
	side?: "top" | "bottom" | "left" | "right"
	children: React.ReactElement
}

export function Hint({ label, side = "top", children }: HintProps) {
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>{children}</TooltipTrigger>
				<TooltipContent side={side}>{label}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	)
}