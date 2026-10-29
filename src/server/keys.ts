/** Read externally managed auth.json credentials into the server environment.
 * Real environment values take precedence over file values. */
import { AUTH_PROVIDER_KEYS, CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { authStore } from "../store/auth.ts";
import { customProviderIds, customProviderPresent, customProviderEnvVars } from "../agent/custom-providers.ts";
import { customProviderAvailable, installCustomProviderSource } from "./custom-provider.ts";
import { claudeCodeAvailable } from "./claude-code-config.ts";
import { CLAUDE_CODE_PROVIDER } from "../agent/claude-code/constants.ts";
import { CUSTOM_AUTH_BINDING } from "../core/custom-provider-auth.ts";
import { authEnvRecord as boot } from "../core/auth-env.ts";

/** The fresh-user switch (owner, interlude 2026-09-22): env keys are
 *  invisible app-wide — deleted from the process at boot, file keys only.
 *  Read live per call (the launcher exports it before boot). */
export function envKeysIgnored(): boolean {
	return process.env.LH_IGNORE_ENV_KEYS === "1";
}

/** Fill unset environment values from the credential file, idempotently. */
export function initAuthEnv(): void {
	const record = boot();
	const fileVars = Object.fromEntries(Object.entries(authStore.authVars()).filter(([name]) => name !== CUSTOM_AUTH_BINDING));
	const managed = new Set<string>([
		...Object.keys(fileVars),
		"TAVILY_API_KEY", "BRAVE_API_KEY",
		...AUTH_PROVIDER_KEYS.map((p) => p.envVar),
		CUSTOM_PROVIDER.envVar, ...customProviderEnvVars(),
	]);
	if (envKeysIgnored()) {
		// Ignore inherited credentials; reflect only the managed file.
		for (const name of managed) {
			delete process.env[name];
			record.realEnv.delete(name);
			record.fillGap.delete(name);
		}
	}
	else {
		for (const name of managed) {
			if (process.env[name] !== undefined && !record.fillGap.has(name)) record.realEnv.add(name);
		}
	}
	for (const [name, value] of Object.entries(fileVars)) {
		// Every string-valued file entry is managed out of band.
		if (process.env[name] === undefined) {
			process.env[name] = value;
			record.fillGap.add(name);
		}
	}
}

/** Read a credential env-first, or file-only when inherited keys are ignored. */
export function keyValue(id: string): string | undefined {
	if (id === CUSTOM_AUTH_BINDING) return undefined;
	// The fresh-user switch: ONLY the file store counts (belt-and-
	// suspenders — the boot deletion already emptied the env; this guards
	// any env key reintroduced after boot).
	if (envKeysIgnored()) return authStore.authVars()[id];
	return process.env[id] ?? authStore.authVars()[id];
}

/** The key-presence truth for one model provider (provider-key interlude,
 * 2026-09-25): would this provider's key be present at request time?
 * Reads through keyValue — the SAME env-first lookup pi-ai performs
 * natively at every request — so an env-shadowed key counts as present
 * (gate by what would run). Providers absent from AUTH_PROVIDER_KEYS take
 * no key at all: nothing to gate, present by definition. */
export function providerKeyPresent(provider: string): boolean {
	if (customProviderIds().includes(provider)) return customProviderPresent(provider);
	if (provider === CUSTOM_PROVIDER.id) return customProviderAvailable();
	// Explicit opt-in + installation only, never authentication readiness.
	// Consulted at admission, not inside already-running agent loops.
	if (provider === CLAUDE_CODE_PROVIDER) return claudeCodeAvailable();
	const info = AUTH_PROVIDER_KEYS.find((p) => p.id === provider);
	return info ? keyValue(info.envVar) !== undefined : true;
}

// Reflect the file into the env at first import (idempotent; the module is
// imported by every route/handler path that touches keys).
initAuthEnv();
installCustomProviderSource();
