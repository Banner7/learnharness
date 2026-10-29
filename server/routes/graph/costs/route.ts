/**
 * GET /api/graph/costs — cost data for the home knowledge summary.
 * The graph pipeline's extraction and audit costs are derived from chat
 * and notes runs using current model prices; no dollar amount is stored.
 *
 * Scope (user-decided): the graph pipeline ONLY — teaching turns and
 * sub-agent jobs have their own cost channels elsewhere.
 */
import { graphCosts } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(graphCosts());
}
