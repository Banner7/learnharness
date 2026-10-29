import { graphView } from "@/src/server";

/**
 * Graph data for the phone home summary and proposition picker. The
 * server derives a read-only snapshot from the stored evidence ledgers.
 */

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(graphView());
}
