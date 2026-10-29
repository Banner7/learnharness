import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { loadClaudeCodeModelNames } from "@/src/server";

const server = serve({
	fetch: app.fetch,
	port: Number(process.env.PORT ?? 3000),
	hostname: process.env.HOSTNAME ?? "0.0.0.0",
}, (info) => {
	console.log(`[server] listening on ${info.address}:${info.port}`);
});

// Fork (2026-10-29): read Claude Code's model names before the first picker
// load asks for them; /api/models also waits (bounded) if this is still running.
void loadClaudeCodeModelNames();

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		// Fork rewrite (2026-10-29): stop accepting requests, let ordinary
		// responses drain, then release permanent SSE subscriptions on exit.
		const deadline = setTimeout(() => process.exit(0), 10_000);
		deadline.unref();
		server.close((error) => {
			clearTimeout(deadline);
			if (error) console.error("[server] shutdown failed", error);
			process.exit(error ? 1 : 0);
		});
	});
}
