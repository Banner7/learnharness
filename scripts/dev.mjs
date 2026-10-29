import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";

try {
	loadEnvFile(".env.local");
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
// Fork rewrite (2026-10-29): two small native child processes replace the
// framework dev server without adding a process-manager dependency.
const children = [
	spawn(process.execPath, ["--import", "tsx", "--watch", "server/main.ts"], { stdio: "inherit" }),
	spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit" }),
];
let stopping = false;
for (const child of children) {
	child.on("error", (error) => {
		console.error("[dev] child failed", error);
		process.exitCode = 1;
		for (const peer of children) peer.kill("SIGTERM");
	});
	child.on("exit", (code) => {
		if (!stopping) {
			stopping = true;
			process.exitCode = code ?? 1;
			for (const peer of children) if (peer !== child) peer.kill("SIGTERM");
		}
	});
}
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		stopping = true;
		for (const child of children) child.kill(signal);
	});
}
