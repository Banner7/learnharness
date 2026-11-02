/**
 * /api/library — the vault library (fork, 2026-11-01). GET reports the
 * follower's state; POST starts "Sync now": a fresh scan, then every
 * waiting note extracts in sequence. POST returns at once — progress rides
 * the usual sources-changed events and /api/graph/status.
 */
import { drainLibrary, libraryStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(libraryStatus());
}

export function POST() {
	const status = libraryStatus();
	if (!status.enabled) return Response.json({ error: "No vault folder is configured on the server." }, { status: 409 });
	void drainLibrary("manual").catch((err) => console.error("[vault] manual sync failed:", err));
	return Response.json({ ...libraryStatus(), draining: true });
}
