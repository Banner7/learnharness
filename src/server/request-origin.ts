/** The origin this request addressed (scheme + Host), for same-origin checks.
 * Same-origin browser intent, not user authentication: never trust forwarded
 * origins or add CORS grants here. */
// Fork port (2026-10-29): upstream keeps this in web-subscription-http.ts,
// which the fork dropped with web subscription sign-in; the Claude Code
// status route is its only remaining user. The private deployment's access
// gate is Tailscale Serve + Basic auth in server/app.ts.
export function requestOrigin(request: Request): string | undefined {
	try {
		const url = new URL(request.url);
		const host = request.headers.get("host") ?? url.host;
		const addressed = new URL(`${url.protocol}//${host}`);
		if (!["http:", "https:"].includes(addressed.protocol) || addressed.username || addressed.password || addressed.pathname !== "/" || addressed.search || addressed.hash) return;
		return addressed.origin;
	} catch { return; }
}
