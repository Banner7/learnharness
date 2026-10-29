import { loadClaudeCodeModelNames, modelCatalog } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). Static
 * catalog: no network, stable within a pi-ai version. Fork (2026-10-29):
 * the first call may wait briefly for Claude Code's local model names.
 */
export async function GET() {
	await loadClaudeCodeModelNames();
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}
