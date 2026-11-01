/**
 * Claude Code binary lookup (src/agent/claude-code/binary.ts).
 *
 * The server process may start with a minimal PATH, so lookup falls back to
 * the standard install locations. A fake isExecutable set stands in for the
 * filesystem.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveClaudeBinary } from "../src/agent/claude-code/binary.ts";

const HOME = "/home/u";

function resolveWith(executables: string[], env: Record<string, string> = {}, platform: NodeJS.Platform = "linux", homeDir = HOME) {
	const found = new Set(executables);
	return resolveClaudeBinary({ env, platform, homeDir, isExecutable: (p) => found.has(p) });
}

test("prefers a PATH hit, then ~/.local/bin, ~/.claude/local, npm global bin, /opt/homebrew/bin, /usr/local/bin in that order", () => {
	assert.equal(resolveWith(["/usr/bin/claude", `${HOME}/.local/bin/claude`], { PATH: "/opt/x:/usr/bin" }), "/usr/bin/claude");
	const all = [`${HOME}/.local/bin/claude`, `${HOME}/.claude/local/claude`, `${HOME}/.npm-global/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
	for (let i = 0; i < all.length; i++) {
		assert.equal(resolveWith(all.slice(i), { PATH: "/usr/bin" }), all[i]);
	}
	assert.equal(resolveWith([], { PATH: "/usr/bin:/bin" }), null, "every location misses");
});

test("npm global bin follows npm_config_prefix when set", () => {
	const binary = resolveWith(["/opt/npm/bin/claude", `${HOME}/.npm-global/bin/claude`], { npm_config_prefix: "/opt/npm" });
	assert.equal(binary, "/opt/npm/bin/claude");
});

test("windows finds native claude.exe anywhere (PATH or ~/.local/bin) and never advertises .cmd-only installs", () => {
	const winHome = "C:\\Users\\u";
	const env = { PATH: "C:\\tools;C:\\bin", APPDATA: `${winHome}\\AppData\\Roaming` };
	assert.equal(resolveWith(["C:\\bin\\claude.cmd"], env, "win32", winHome), null);
	assert.equal(resolveWith([`${winHome}\\AppData\\Roaming\\npm\\claude.cmd`], env, "win32", winHome), null);
	assert.equal(resolveWith(["C:\\bin\\claude"], env, "win32", winHome), null);
	assert.equal(resolveWith(["C:\\bin\\claude.exe"], env, "win32", winHome), "C:\\bin\\claude.exe");
	// claude.exe beats a PATH claude.cmd, which Node cannot spawn without a shell
	assert.equal(resolveWith(["C:\\bin\\claude.cmd", `${winHome}\\.local\\bin\\claude.exe`], env, "win32", winHome), `${winHome}\\.local\\bin\\claude.exe`);
});

test("relative Windows PATH entries are fixed to an absolute discovery identity", () => {
	assert.equal(resolveClaudeBinary({ env: { PATH: ".\\bin" }, platform: "win32", homeDir: "C:\\Users\\u", cwd: "C:\\server",
		isExecutable: (candidate) => candidate === "C:\\server\\bin\\claude.exe",
	}), "C:\\server\\bin\\claude.exe");
});
