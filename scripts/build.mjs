import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const runtime = path.join(root, "dist/runtime/src/agent");
await rm(path.join(root, "dist/runtime"), { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
// Fork rewrite (2026-10-29): packages stay external because native bindings,
// WASM, pdfjs workers/fonts and pi-ai provider data need real runtime paths.
// The image ships only the lockfile closure of the recorded runtime roots
// (scripts/prune-runtime.mjs).
const result = await build({
	absWorkingDir: root,
	entryPoints: ["server/main.ts"],
	outfile: "dist/server.js",
	bundle: true,
	packages: "external",
	platform: "node",
	format: "esm",
	target: "node22",
	sourcemap: true,
	metafile: true,
	logLevel: "info",
});
// Copy only immutable runtime inputs, never repository data or credentials.
for (const asset of ["system-prompt.md", "prompts", "image-processing"]) {
	await cp(path.join(root, "src/agent", asset), path.join(runtime, asset), {
		recursive: true,
		filter: (source) => !source.endsWith(".ts"),
	});
}

// Fork (2026-10-29): record the packages the server actually loads, so the
// image can drop everything else (client-only packages are bundled by Vite).
// Include the bundle's external imports and bare imports in all copied runtime
// JavaScript assets, which esbuild never sees. scripts/prune-runtime.mjs
// consumes these roots.
const packageName = (specifier) => {
	if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) return null;
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
};
const builtins = new Set((await import("node:module")).builtinModules);
const roots = new Set();
for (const output of Object.values(result.metafile.outputs)) {
	for (const entry of output.imports) {
		const name = entry.external ? packageName(entry.path) : null;
		if (name && !builtins.has(name)) roots.add(name);
	}
}
const importSpecifier = /(?:\bfrom\s*|\bimport\s*(?:\(\s*|\s+)|\brequire\s*\(\s*)["']([^"']+)["']/g;
async function scanRuntime(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await scanRuntime(file);
		} else if (entry.isFile() && [".mjs", ".js", ".cjs"].includes(path.extname(entry.name))) {
			const source = await readFile(file, "utf8");
			for (const match of source.matchAll(importSpecifier)) {
				const name = packageName(match[1]);
				if (name && !builtins.has(name)) roots.add(name);
			}
		}
	}
}
await scanRuntime(path.join(root, "dist/runtime"));
await writeFile(path.join(root, "dist/runtime-packages.json"), `${JSON.stringify([...roots].sort(), null, "\t")}\n`);
console.log(`runtime packages: ${roots.size} roots`);

// Fork (2026-10-30): neither the server nor Tailscale Serve compressed
// responses, so the phone downloaded the 1.8 MB entry chunk raw (554 KB
// gzipped). Compress text assets once here; server/app.ts serves the .br/.gz
// sibling through serveStatic's `precompressed` option. A variant that saves
// nothing is skipped and the original is served instead.
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const compressible = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".txt"]);
let rawBytes = 0;
let brBytes = 0;
async function precompress(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await precompress(file);
			continue;
		}
		if (!entry.isFile() || !compressible.has(path.extname(entry.name))) continue;
		const source = await readFile(file);
		const [br, gz] = await Promise.all([
			brotli(source, { params: { [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY, [zlib.BROTLI_PARAM_SIZE_HINT]: source.length } }),
			gzipAsync(source, { level: zlib.Z_BEST_COMPRESSION }),
		]);
		rawBytes += source.length;
		brBytes += Math.min(br.length, source.length);
		if (br.length < source.length) await writeFile(`${file}.br`, br);
		if (gz.length < source.length) await writeFile(`${file}.gz`, gz);
	}
}
await precompress(path.join(root, "dist/client"));
console.log(`precompressed client: ${(rawBytes / 1e6).toFixed(1)} MB -> ${(brBytes / 1e6).toFixed(1)} MB brotli`);
