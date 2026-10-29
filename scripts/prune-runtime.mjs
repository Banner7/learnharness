// Fork (2026-10-29): runtime image slimming. After `npm ci --omit=dev`, keep
// only the packages the server can load — the roots scripts/build.mjs records
// in dist/runtime-packages.json, plus their dependency closure in
// package-lock.json (dependencies, optional and installed peers, resolved the
// way Node does: nearest node_modules upward) — and delete the rest. The
// client-only packages (mermaid, lucide-react, streamdown, cytoscape, React…)
// are already bundled into dist/client, so the image never needs them.
//
// Usage: node prune-runtime.mjs <app dir> <runtime-packages.json>
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const [appDir, rootsFile] = process.argv.slice(2);
if (!appDir || !rootsFile) throw new Error("usage: prune-runtime.mjs <app dir> <runtime-packages.json>");

const lock = JSON.parse(readFileSync(path.join(appDir, "package-lock.json"), "utf8"));
const packages = lock.packages ?? {};
const roots = JSON.parse(readFileSync(rootsFile, "utf8"));

/** Node's lookup from the package at `from` ("" = the app): nearest node_modules upward. */
function resolve(from, name) {
	let base = from;
	for (;;) {
		const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
		if (packages[candidate]) return candidate;
		if (!base) return null;
		const cut = base.lastIndexOf("/node_modules/");
		base = cut === -1 ? "" : base.slice(0, cut);
	}
}

const keep = new Set();
const queue = [];
for (const name of roots) {
	const found = resolve("", name);
	if (!found) throw new Error(`runtime package ${name} is not in package-lock.json`);
	queue.push(found);
}
while (queue.length > 0) {
	const at = queue.pop();
	if (keep.has(at)) continue;
	keep.add(at);
	const meta = packages[at];
	const names = [
		...Object.keys(meta.dependencies ?? {}),
		...Object.keys(meta.optionalDependencies ?? {}),
		...Object.keys(meta.peerDependencies ?? {}),
	];
	for (const name of names) {
		const found = resolve(at, name);
		// Optional deps for other platforms and uninstalled optional peers have no entry.
		if (found) queue.push(found);
	}
}

const dirSize = (dir) => {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) total += dirSize(full);
		else if (entry.isFile()) total += statSync(full).size;
	}
	return total;
};
const modules = path.join(appDir, "node_modules");
const before = dirSize(modules);

let removed = 0;
for (const key of Object.keys(packages).sort((a, b) => a.length - b.length)) {
	if (!key.startsWith("node_modules/") || keep.has(key)) continue;
	const full = path.join(appDir, key);
	if (!existsSync(full)) continue; // dev-only, other-platform, or under an already-removed parent
	rmSync(full, { recursive: true, force: true });
	removed++;
}
// Drop .bin links whose package is gone.
const bin = path.join(modules, ".bin");
if (existsSync(bin)) {
	for (const link of readdirSync(bin)) {
		if (!existsSync(path.join(bin, link))) rmSync(path.join(bin, link), { force: true });
	}
}
const after = dirSize(modules);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
console.log(`prune-runtime: kept ${keep.size} packages, removed ${removed}; node_modules ${mb(before)} -> ${mb(after)}`);
