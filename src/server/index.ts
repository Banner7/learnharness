/**
 * THE SERVER-SIDE SURFACE — the only src module (besides the core barrel)
 * that server/ may import. The Hono transport and route handlers come through
 * here; nothing under server/ touches src/store or src/agent directly.
 */

export * from "./chat-handler.ts";
export * from "./events-stream.ts";
export * from "./chats.ts";
export * from "./graph.ts";
export { NotesImportError } from "../agent/subagents/extraction.ts";
export * from "./jobs.ts";
export * from "./stores.ts";
// The settings record + prompt overrides (settings-storage wave, 2026-09-19).
// The *Record aliases keep the server/routes/settings routes explicit about which
// seam they touch (the raw record, not the chat-section convenience view).
export {
	readSettings as readSettingsRecord,
	writeSettings as writeSettingsRecord,
	settingsStore,
} from "../store/settings.ts";
export { promptOverrides } from "../store/prompt-overrides.ts";
export { isValidSegmentPath } from "../core/prompt-segments.ts";
// The canonical segment discovery/resolution lives in the agent layer
// (composition is an agent concern); the barrel re-exports it for the
// routes — server→agent is the lawful direction (chat-handler precedent).
export { effectivePromptSegments, allSegmentPaths } from "../agent/prompt-segments.ts";

// Read server-owned credentials and project provider availability to the catalog.
export * from "./keys.ts";
export * from "./search.ts";
export * from "./settings-body.ts";
export * from "./turn-liveness.ts";
export * from "./turn-runs.ts";
export * from "./dismissal-park.ts";
export * from "./compaction.ts";
export { piTurnResponse } from "./pi/ui-stream.ts";
export * from "./observability.ts";
export * from "./model-catalog.ts";
export { sessionCost } from "./pricing.ts";
export { claudeCodeInstallationResponse } from "./claude-code.ts";
// The custom endpoint module (registers into piModels() + probes for models).
// No import side effects; the boot sync lives in stores.ts.
export * from "./custom-provider.ts";
export { browserAccessFailure } from "./web-access.ts";
