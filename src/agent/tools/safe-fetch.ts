import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Outbound fetch for model-driven tools (web_fetch, web_fetch_pdf). The URL
 * comes from the model, and the model can be steered by a fetched page, PDF
 * or note, so the server must never become a proxy into its own host or
 * network (SSRF): loopback apps, Docker bridges, the tailnet, cloud metadata.
 *
 * Every hop is checked: the protocol must be http(s) and every address the
 * hostname resolves to must be public. Redirects are followed by hand
 * (max MAX_REDIRECTS) so a public URL cannot bounce to a private one.
 *
 * Residual: DNS rebinding. fetch resolves the name again when it connects;
 * a hostile name with a near-zero TTL could answer public here and private
 * there. Closing that needs a connect-time lookup hook (an undici dispatcher).
 */

const MAX_REDIRECTS = 5;

const blocked = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8], // "this network"
	["10.0.0.0", 8],
	["100.64.0.0", 10], // CGNAT, includes the Tailscale range
	["127.0.0.0", 8],
	["169.254.0.0", 16], // link-local, cloud metadata
	["172.16.0.0", 12], // includes Docker bridges
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved + broadcast
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96], // NAT64 can map to private IPv4
	["100::", 64],
	["2001:db8::", 32],
	["fc00::", 7], // unique local, includes Tailscale fd7a:115c:a1e0::/48
	["fe80::", 10],
	["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** True when the address is loopback, private, link-local, tailnet or otherwise not public. */
export function isBlockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return blocked.check(address, "ipv4");
	if (family !== 6) return true;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (mapped) return blocked.check(mapped[1]!, "ipv4");
	return blocked.check(address, "ipv6");
}

async function assertPublicUrl(url: URL): Promise<void> {
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are supported");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost")) throw new Error("Refusing to fetch a private address");
	const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
	if (addresses.length === 0 || addresses.some(isBlockedAddress)) throw new Error("Refusing to fetch a private address");
}

/** fetch() that refuses private destinations on every hop. Returns the
 *  final response and the URL it came from. Throws on a refused hop. */
export async function safeFetch(url: string, init: RequestInit): Promise<{ response: Response; url: string }> {
	let current = new URL(url);
	for (let hop = 0; ; hop++) {
		await assertPublicUrl(current);
		const response = await fetch(current, { ...init, redirect: "manual" });
		const location = response.headers.get("location");
		if (response.status < 300 || response.status > 399 || !location) return { response, url: current.href };
		if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects");
		await response.body?.cancel();
		current = new URL(location, current);
	}
}
