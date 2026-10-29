"use client";

import { useEffect, useState } from "react";
import type { CatalogProvider, ClaudeCodeStatus, ModelCatalogResponse, UserSettings } from "@/src/core";
import { SettingsGroup, StatusRow } from "./controls.tsx";

/** Connections are configured out-of-band; this view only reports server status. */
// Fork (2026-10-29): derive status rows from server configuration rather than naming a private provider in the UI.
export function ProvidersSection() {
	const [serverProviders, setServerProviders] = useState<CatalogProvider[]>([]);
	const [claude, setClaude] = useState<ClaudeCodeStatus | "disabled" | null>(null);
	const [catalogError, setCatalogError] = useState(false);
	const [claudeError, setClaudeError] = useState(false);

	useEffect(() => {
		let active = true;
		void fetch("/api/models")
			.then((response) => { if (!response.ok) throw new Error("Model catalog unavailable"); return response.json() as Promise<ModelCatalogResponse>; })
			.then((body) => { if (active) setServerProviders(body.providers.filter((provider) => provider.serverManaged)); })
			.catch(() => { if (active) setCatalogError(true); });
		void (async () => {
			try {
				const response = await fetch("/api/settings");
				if (!response.ok) throw new Error("Settings unavailable");
				const body = await response.json() as { settings: UserSettings | null };
				// Fork port (2026-10-29): the phone UI stays read-only. Enable the
				// real Claude CLI on the server via settings.json's claudeCode.enabled;
				// installation status is not an authentication or billing verdict.
				if (!body.settings?.claudeCode?.enabled) {
					if (active) setClaude("disabled");
					return;
				}
				const status = await fetch("/api/claude-code", { headers: { "x-learnharness-claude-code": "1" } });
				if (!status.ok) throw new Error("Claude Code status unavailable");
				const installation = await status.json() as ClaudeCodeStatus;
				if (active) setClaude(installation);
			} catch { if (active) setClaudeError(true); }
		})();
		return () => { active = false; };
	}, []);

	const claudeLabel = claudeError ? "Unavailable" : claude === null ? "Checking…" : claude === "disabled" ? "Disabled"
		: claude.state === "not-found" ? "CLI not installed" : claude.state === "update-required" ? "CLI update required"
		: claude.state === "version-unchecked" ? "CLI version unchecked" : "CLI available";
	return (
		<SettingsGroup label="This server" testid="group-server-providers">
			<StatusRow testid="server-provider-claude-code" label="Claude Code" status={claudeLabel}
				hint="Managed on the server; authentication and billing follow the CLI configuration" />
			{serverProviders.map((provider) => (
				<StatusRow key={provider.id} testid={`server-provider-${provider.id}`} label={provider.name ?? provider.id}
					status={catalogError ? "Unavailable" : provider.keyPresent ? "Connected" : "Not connected"}
					hint="Managed on the server" />
			))}
		</SettingsGroup>
	);
}
