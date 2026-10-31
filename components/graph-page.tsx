import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "wouter";
import { SidebarToggle } from "./sidebar";

// Graph page restored for desktop (2026-10-31): this lightweight route must
// check the viewport before importing the canvas or its d3 dependencies.
const GraphView = lazy(() => import("./graph-view").then(({ GraphView }) => ({ default: GraphView })));
const DESKTOP_QUERY = "(min-width: 1100px)";

export function GraphPage() {
	const [desktop, setDesktop] = useState(() => typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches);
	useEffect(() => {
		const media = window.matchMedia(DESKTOP_QUERY);
		setDesktop(media.matches);
		const onChange = (event: MediaQueryListEvent) => setDesktop(event.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);

	if (!desktop) {
		return <main className="mx-auto flex min-h-dvh max-w-[560px] flex-col justify-center gap-4 px-6 font-ui">
			<h1 className="font-title text-2xl text-foreground">Graph is for desktop</h1>
			<p className="text-sm leading-relaxed text-muted-foreground">Explore your knowledge through Chains on this screen.</p>
			<Link href="/?chains=1" className="min-h-11 self-start text-sm font-medium text-primary underline underline-offset-4">Open Chains</Link>
		</main>;
	}

	return <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
		<header className="flex h-14 shrink-0 items-center gap-4 border-b border-border px-5 font-ui">
			<SidebarToggle />
			<Link href="/" className="text-sm text-muted-foreground transition-colors hover:text-foreground">Home</Link>
			<span aria-hidden="true" className="text-muted-foreground/50">/</span>
			<h1 className="font-title text-lg">Knowledge graph</h1>
		</header>
		<div className="relative min-h-0 flex-1">
			<Suspense fallback={<p role="status" className="p-6 text-sm text-muted-foreground">Loading graph…</p>}>
				<GraphView />
			</Suspense>
		</div>
	</main>;
}
