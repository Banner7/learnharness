import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import "@fontsource/atkinson-hyperlegible-next/latin-400.css";
import "@fontsource/atkinson-hyperlegible-next/latin-500.css";
import "@fontsource/atkinson-hyperlegible-next/latin-600.css";
import "@fontsource/atkinson-hyperlegible-next/latin-700.css";
import "@fontsource/atkinson-hyperlegible-next/latin-400-italic.css";
import "@fontsource/atkinson-hyperlegible-next/latin-500-italic.css";
import "@fontsource/atkinson-hyperlegible-next/latin-600-italic.css";
import "@fontsource/atkinson-hyperlegible-next/latin-700-italic.css";
import "@fontsource-variable/jetbrains-mono";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { NavigationProvider } from "./navigation";
import { Pages } from "./pages";

createRoot(document.getElementById("root")!).render(
	<Router>
		<NavigationProvider>
			<ServerEventsProvider>
				<AppearanceProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell><Pages /></AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
		</NavigationProvider>
	</Router>,
);
