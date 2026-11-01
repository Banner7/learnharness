/**
 * The custom OpenAI-compatible endpoint: turns the user's non-secret config
 * (base URL + discovered models) into a pi-ai provider registered in
 * `piModels()`, so its models fill the same slots as any built-in. Keyless
 * local servers work via a placeholder key resolved at request time.
 */

import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { configureProviderSource, piModels } from "../agent/models.ts";
import { readSettings } from "../store/settings.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { customBindingMatches } from "../core/custom-provider-auth.ts";
import { customAuthState, customKeyAuthorized } from "./custom-provider-auth.ts";
import {
	CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
	CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
	customProviderUsable,
	type CustomModel,
	type CustomModelOverride,
} from "../core/settings.ts";


/** Placeholder bearer for keyless endpoints (the OpenAI client needs *a* key). */
const KEYLESS_PLACEHOLDER = "not-needed";

/** Install the sole custom source: donor settings + explicit authentication.
 * Publication captures a consistent snapshot; an already-started operation
 * cannot acquire a later endpoint's key. No file configuration source exists. */
export function installCustomProviderSource(readAuth = customAuthState): void {
	let fingerprint: string | undefined;
	configureProviderSource({
		isCustom: (id) => id === CUSTOM_PROVIDER.id,
		sync(models) {
			const cp = readSettings()?.customProvider;
			// Validate the durable nonce/URL/mode before resolving ANY credential.
			// Keyless reads only the nonsecret marker, never a file/env key.
			const auth = readAuth(cp?.authMode === "apiKey", cp);
			const key = auth.key;
			const ready = customProviderUsable(cp) && auth.readable && customBindingMatches(cp, auth.binding) && (cp.authMode === "keyless" || customKeyAuthorized(cp, auth));
			const next = JSON.stringify([cp, auth]); // Private in-memory fingerprint, never a public revision.
			if (next === fingerprint) return;
			if (ready) models.setProvider(buildOpenAiCompatibleProvider({ ...cp, baseUrl: cp.baseUrl, models: cp.models ?? [], apiKey: key }));
			else models.deleteProvider(CUSTOM_PROVIDER.id);
			fingerprint = next;
		},
	});
}

export function customProviderAvailable(): boolean {
	return piModels().getProvider(CUSTOM_PROVIDER.id) !== undefined;
}

/** Map a discovered model to a pi-ai entry: image→input, reasoning→thinking
 *  levels, context/maxTokens→limits. Resolution ladder (owner, 2026-10-27):
 *  the user's pin wins, then the endpoint's own metadata, then the compiled
 *  default — a local server that says nothing (or says 8k) can be corrected.
 *  baseUrl is stamped per-model. */
function toPiModel(
	model: CustomModel,
	baseUrl: string,
	overrides: Record<string, CustomModelOverride>,
): Model<Api> {
	const pin = overrides[model.id];
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: CUSTOM_PROVIDER.id,
		baseUrl,
		// Pin wins; else detected from the endpoint's metadata (see
		// detectReasoning). true makes pi-ai offer the standard levels and send
		// reasoning_effort on the wire; no thinkingLevelMap → the default
		// off/minimal/low/medium/high set.
		reasoning: pin?.reasoning ?? Boolean(model.reasoning),
		input: model.image ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: pin?.context ?? model.context ?? CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
		maxTokens: pin?.maxTokens ?? model.maxTokens ?? CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
		type: "chat",
	};
}

/** Build an OpenAI-compatible provider from parts. baseUrl must be normalized. */
export function buildOpenAiCompatibleProvider(input: {
	baseUrl: string;
	models: readonly CustomModel[];
	/** User pins by model id (see CustomModelOverride) — absent = none. */
	overrides?: Record<string, CustomModelOverride>;
	/** Already resolved for this publication; absent means explicit keyless. */
	apiKey?: string;
}): Provider<Api> {
	const overrides = input.overrides ?? {};
	return createProvider<Api>({
		id: CUSTOM_PROVIDER.id,
		name: CUSTOM_PROVIDER.label,
		baseUrl: input.baseUrl,
		auth: { apiKey: {
			name: `${CUSTOM_PROVIDER.label} API key`,
			resolve: async () => ({ auth: { apiKey: input.apiKey ?? KEYLESS_PLACEHOLDER }, source: input.apiKey ? CUSTOM_PROVIDER.envVar : "keyless" }),
		} },
		models: input.models.map((m) => toPiModel(m, input.baseUrl, overrides)),
		api: openAICompletionsApi(),
	});
}

/** Re-sync the provider into piModels() (idempotent): usable → rebuild;
 *  not usable → remove. Never throws. */
export function syncCustomProvider(): void {
	piModels();
}

