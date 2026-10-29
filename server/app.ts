import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { browserAccessFailure } from "@/src/server";
import * as activity from "./routes/activity/route.ts";
import * as activityAbort from "./routes/activity/abort/route.ts";
import * as chat from "./routes/chat/route.ts";
import * as chats from "./routes/chats/route.ts";
import * as chatDetail from "./routes/chats/[id]/route.ts";
import * as chatArtifact from "./routes/chats/[id]/artifact-ui/route.ts";
import * as chatDismiss from "./routes/chats/[id]/dismiss/route.ts";
import * as chatMarkdown from "./routes/chats/[id]/markdown/route.ts";
import * as chatSettings from "./routes/chats/[id]/settings/route.ts";
import * as chatSteer from "./routes/chats/[id]/steer/route.ts";
import * as chatStream from "./routes/chats/[id]/stream/route.ts";
import * as claudeCode from "./routes/claude-code/route.ts";
import * as events from "./routes/events/route.ts";
import * as graph from "./routes/graph/route.ts";
import * as graphCosts from "./routes/graph/costs/route.ts";
import * as graphExtract from "./routes/graph/coverage/extract/route.ts";
import * as graphImport from "./routes/graph/import/route.ts";
import * as graphNode from "./routes/graph/nodes/[id]/route.ts";
import * as graphStatus from "./routes/graph/status/route.ts";
import * as jobs from "./routes/jobs/route.ts";
import * as models from "./routes/models/route.ts";
import * as search from "./routes/search/route.ts";
import * as settings from "./routes/settings/route.ts";
import * as settingsSection from "./routes/settings/[section]/route.ts";
import * as prompts from "./routes/settings/prompts/route.ts";
import * as promptSegment from "./routes/settings/prompts/[...segment]/route.ts";

export const app = new Hono();

// Fork rewrite (2026-10-29): the former proxy matched every path. Keep the
// gate ahead of both API dispatch and the static/SPA handlers added at boot.
app.use("*", async (c, next) => {
	const request = c.req.raw;
	const failure = browserAccessFailure(request.headers, request.method, process.env, c.req.path);
	if (failure?.status === 403) {
		const q = (name: string) => JSON.stringify(request.headers.get(name));
		console.warn(`[access] 403 ${request.method} ${JSON.stringify(c.req.path)} site=${q("sec-fetch-site")} mode=${q("sec-fetch-mode")} dest=${q("sec-fetch-dest")} origin=${q("origin")} ua=${q("user-agent")}`);
	}
	c.header("Cache-Control", "private, no-store");
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "same-origin");
	if (failure) {
		if (failure.status === 401) c.header("WWW-Authenticate", 'Basic realm="LearnHarness", charset="UTF-8"');
		return c.json({ error: failure.error }, failure.status);
	}
	await next();
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "same-origin");
	if (c.req.path === "/api" || c.req.path.startsWith("/api/") || !c.res.headers.has("Cache-Control")) {
		c.header("Cache-Control", "private, no-store");
	}
});

const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"] as const;
type Method = typeof methods[number];
type RouteHandlers<P> = Partial<Record<Method, (request: Request, context: { params: Promise<P> }) => Response | Promise<Response>>>;

function mount<P = Record<string, never>>(
	path: string,
	handlers: RouteHandlers<P>,
	parameters: (c: Context) => P = () => ({} as P),
) {
	const supported = methods.filter((method) => typeof handlers[method] === "function");
	const allow = [...new Set([...supported, ...(handlers.GET ? ["HEAD"] : []), "OPTIONS"])].sort().join(", ");
	for (const method of supported) {
		const handler = handlers[method]!;
		app.on(method, path, (c) => handler(c.req.raw, { params: Promise.resolve(parameters(c)) }));
	}
	// Route handlers previously inherited automatic OPTIONS and 405 responses.
	app.all(path, (c) => {
		c.header("Allow", allow);
		return c.body(null, c.req.method === "OPTIONS" ? 204 : 405);
	});
}

const id = (c: Context) => ({ id: c.req.param("id")! });
mount("/api/activity", activity);
mount("/api/activity/abort", activityAbort);
mount("/api/chat", chat);
mount("/api/chats", chats);
mount("/api/chats/:id", chatDetail, id);
mount("/api/chats/:id/artifact-ui", chatArtifact, id);
mount("/api/chats/:id/dismiss", chatDismiss, id);
mount("/api/chats/:id/markdown", chatMarkdown, id);
mount("/api/chats/:id/settings", chatSettings, id);
mount("/api/chats/:id/steer", chatSteer, id);
mount("/api/chats/:id/stream", chatStream, id);
mount("/api/claude-code", claudeCode);
mount("/api/events", events);
mount("/api/graph", graph);
mount("/api/graph/costs", graphCosts);
mount("/api/graph/coverage/extract", graphExtract);
mount("/api/graph/import", graphImport);
mount("/api/graph/nodes/:id", graphNode, id);
mount("/api/graph/status", graphStatus);
mount("/api/jobs", jobs);
mount("/api/models", models);
mount("/api/search", search);
mount("/api/settings", settings);
mount("/api/settings/prompts", prompts);
mount("/api/settings/prompts/*", promptSegment, (c) => ({
	segment: c.req.path.slice("/api/settings/prompts/".length).split("/").map(decodeURIComponent),
}));
mount("/api/settings/:section", settingsSection, (c) => ({ section: c.req.param("section")! }));

app.all("/api", (c) => c.json({ error: "Not found" }, 404));
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

app.on(["GET", "HEAD"], "*", serveStatic({
	root: "./dist/client",
	onFound: (_path, c) => {
		// Fork rewrite (2026-10-29): only content-hashed Vite assets are
		// immutable. HTML must revalidate so deploys pick up the new bundle.
		c.header("Cache-Control", /^\/assets\/.+-[\w-]+\.[\w.]+$/.test(c.req.path)
			? "private, max-age=31536000, immutable"
			: "private, no-cache");
	},
}));
app.on(["GET", "HEAD"], "*", serveStatic({
	path: "./dist/client/index.html",
	onFound: (_path, c) => { c.header("Cache-Control", "private, no-cache"); },
}));
app.notFound((c) => c.json({ error: "Not found" }, 404));
