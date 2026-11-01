/**
 * LH_IGNORE_ENV_KEYS=1 — the fresh-user switch: env keys invisible app-wide;
 * only auth.json counts. Its own process because the switch is boot-time
 * (initAuthEnv deletes the managed env vars once). The unset behavior is
 * pinned in tests/server-keys.test.ts. Values are throwaway test strings.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// THIS PROCESS'S ENV IS THE TEST SUBJECT — strip any inherited catalog
// vars (a developer shell may export REAL keys; tests use throwaway
// values only, never real secrets).
for (const varName of [
	"OPENROUTER_API_KEY",
	"TAVILY_API_KEY",
	"BRAVE_API_KEY",
	"OPENAI_API_KEY",
	"ZAI_API_KEY",
]) {
	delete process.env[varName];
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fresh-env-keys-"));
const AUTH = path.join(TMP, "auth.json");
process.env.LH_AUTH_FILE = AUTH;

// The file BEFORE first boot: one file-only key.
fs.writeFileSync(AUTH, JSON.stringify({ OPENAI_API_KEY: "sk-file-fresh-file-fresh" }));

// The env the switch must hide — set BEFORE the module's first import:
//  - an env-ONLY provider key (the engine-path specimen)
//  - the SAME var the file holds (the collision specimen: under the
//    switch the FILE value must win, and the env copy must be deleted)
process.env.OPENROUTER_API_KEY = "sk-or-env-env-env";
process.env.OPENAI_API_KEY = "sk-openai-env-env-env";

// THE SWITCH — set before first import (exactly how the launcher boots).
process.env.LH_IGNORE_ENV_KEYS = "1";

// Import AFTER env setup — module init runs the boot deletion + fill-gap.
const { initAuthEnv, keyValue } = await import(
	"../src/server/keys.ts"
);
const { authStore } = await import("../src/store/auth.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("the fresh-user switch (boot under LH_IGNORE_ENV_KEYS=1)", () => {
	it("boot deletes env-only keys (pi-ai reads process.env natively) and the FILE value fills a file-backed var", () => {
		assert.equal(process.env.OPENROUTER_API_KEY, undefined, "deleted from process.env at boot");
		assert.equal(process.env.OPENAI_API_KEY, "sk-file-fresh-file-fresh", "the env copy died; the fill-gap reflected the file value");
		assert.equal(authStore.authVars().OPENAI_API_KEY, "sk-file-fresh-file-fresh");
	});

	it("keyValue: env keys invisible, file keys visible — and a post-boot env reintroduction stays invisible (belt-and-suspenders)", () => {
		assert.equal(keyValue("OPENROUTER_API_KEY"), undefined, "env key invisible under the switch");
		assert.equal(keyValue("OPENAI_API_KEY"), "sk-file-fresh-file-fresh", "file key visible");
		// A stray consumer re-sets an env key AFTER boot: the seam still
		// ignores it (the deletion is boot-time; the read guard is live).
		process.env.OPENROUTER_API_KEY = "sk-or-reintroduced-late";
		try {
			assert.equal(keyValue("OPENROUTER_API_KEY"), undefined, "reintroduced env key stays invisible to the seam");
		} finally {
			delete process.env.OPENROUTER_API_KEY;
		}
	});

	it("unset switch = today's env-wins behavior (the read seam, live-checked)", () => {
		// The dynamic half of the seam: WITHOUT the switch, keyValue reads
		// env first — today's behavior, byte-for-byte (the boot-snapshot
		// half is pinned in tests/server-keys.test.ts, the visible case).
		process.env.LH_IGNORE_ENV_KEYS = undefined;
		process.env.OPENROUTER_API_KEY = "sk-or-env-wins";
		try {
			assert.equal(keyValue("OPENROUTER_API_KEY"), "sk-or-env-wins", "env wins without the switch");
			assert.equal(keyValue("OPENAI_API_KEY"), "sk-file-fresh-file-fresh", "file is the fallback without the switch");
		} finally {
			delete process.env.OPENROUTER_API_KEY;
			process.env.LH_IGNORE_ENV_KEYS = "1";
		}
	});

	it("re-running initAuthEnv is idempotent — deleted env keys never resurrect", () => {
		process.env.OPENROUTER_API_KEY = "sk-or-zombie";
		initAuthEnv();
		assert.equal(process.env.OPENROUTER_API_KEY, undefined, "a reintroduced env key is re-deleted");
		assert.equal(process.env.OPENAI_API_KEY, "sk-file-fresh-file-fresh", "the file reflection survives re-init");
	});
});
