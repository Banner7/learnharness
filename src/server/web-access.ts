import { timingSafeEqual } from "node:crypto";

type AccessFailure = { status: 401 | 403 | 503; error: string };

/** A single-owner browser gate: an allowlisted Tailscale Serve identity, or
 *  the HTTP Basic access token. Never trusts forwarded auth. `pathname` is
 *  optional; without it every request gets the strict cross-site check. */
export function browserAccessFailure(
	headers: Headers,
	method: string,
	env: Record<string, string | undefined> = process.env,
	pathname?: string,
): AccessFailure | null {
	const token = env.LH_WEB_ACCESS_TOKEN;
	const configuredOrigin = env.LH_WEB_ORIGIN;
	if (!token || !/^[a-f0-9]{64}$/i.test(token) || !configuredOrigin) {
		return { status: 503, error: "Browser access requires LH_WEB_ACCESS_TOKEN and LH_WEB_ORIGIN on the server." };
	}

	let origin: URL;
	try {
		origin = new URL(configuredOrigin);
	} catch {
		return { status: 503, error: "LH_WEB_ORIGIN must be an HTTPS origin (or HTTP loopback for local development)." };
	}
	const localHTTP = origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
	if ((!localHTTP && origin.protocol !== "https:") || origin.username || origin.password ||
		origin.pathname !== "/" || origin.search || origin.hash) {
		return { status: 503, error: "LH_WEB_ORIGIN must be an HTTPS origin (or HTTP loopback for local development)." };
	}

	// Serve must preserve the public Host. Do not accept spoofable forwarding
	// headers or alternate origins, even when they carry the right password.
	if (headers.get("host")?.toLowerCase() !== origin.host.toLowerCase()) {
		return { status: 403, error: "Browser access requires the configured LH_WEB_ORIGIN host." };
	}
	const suppliedOrigin = headers.get("origin");
	const fetchSite = headers.get("sec-fetch-site");
	const safeMethod = method === "GET" || method === "HEAD" || method === "OPTIONS";
	// Top-level page loads may arrive cross-site (owner, 2026-10-28): Firefox
	// on iOS was refused here. It serves its start and restore pages from
	// localhost, so a page load from them is likely labeled `cross-site` (the
	// proxy logs refused fetch metadata to confirm). A page load still needs
	// the login below, cannot be framed (X-Frame-Options) and gives the other
	// site nothing to read. APIs, the event stream and every mutation keep
	// the strict same-origin rule.
	const pageLoad = (method === "GET" || method === "HEAD") &&
		headers.get("sec-fetch-mode") === "navigate" && headers.get("sec-fetch-dest") === "document" &&
		pathname !== undefined && pathname !== "/api" && !pathname.startsWith("/api/");
	if ((suppliedOrigin !== null && suppliedOrigin !== origin.origin) ||
		(!pageLoad && fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") ||
		(!safeMethod && suppliedOrigin !== origin.origin)) {
		return { status: 403, error: "Cross-origin browser access is not allowed." };
	}

	// Tailscale Serve deletes client-supplied Tailscale-User-* headers and sets
	// them only for untagged tailnet users. The server must listen on loopback
	// only, so just local processes on the Serve host could forge this header.
	const allowedLogins = (env.LH_TAILSCALE_USERS ?? "").split(",")
		.map((login) => login.trim().toLowerCase()).filter(Boolean);
	const login = headers.get("tailscale-user-login")?.trim().toLowerCase();
	if (login && allowedLogins.includes(login)) return null;

	// Basic auth lets Safari supply credentials to native fetch, downloads and
	// EventSource without placing this capability in a URL, JS or localStorage.
	const supplied = headers.get("authorization");
	const match = supplied && supplied.length < 256 ? /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(supplied) : null;
	const wanted = Buffer.from(`learnharness:${token}`).toString("base64");
	const actual = Buffer.from(match?.[1] ?? "");
	const expected = Buffer.from(wanted);
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		return { status: 401, error: "Sign in with username learnharness and the server's browser access token." };
	}
	return null;
}
