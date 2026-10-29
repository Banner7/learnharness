/** File credential reflection and env-first precedence, using throwaway keys. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { externalCliEnv } from "../src/core/auth-env.ts";

// THIS PROCESS'S ENV IS THE TEST SUBJECT — strip any inherited catalog vars
// (a developer shell may export REAL keys; tests use throwaway values only,
// never real secrets). The strip affects only this disposable child process.
for (const varName of [
	"OPENROUTER_API_KEY",
	"TAVILY_API_KEY",
	"BRAVE_API_KEY",
	"GOOGLE_SEARCH_API_KEY",
	"GOOGLE_CSE_ID",
	"OPENAI_API_KEY",
	"FUTURE_PLANS_TOKEN",
]) {
	delete process.env[varName];
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-keys-"));
const AUTH = path.join(TMP, "auth.json");
process.env.LH_AUTH_FILE = AUTH;

// Existing file credentials: an env-shadowed provider and an opaque var.
fs.writeFileSync(
	AUTH,
	JSON.stringify({
		OPENROUTER_API_KEY: "sk-or-v1-filefilefile",
		FUTURE_PLANS_TOKEN: "opaque-plans-token",
	}),
);
// Real environment values are present before importing the credential seam.
process.env.OPENROUTER_API_KEY = "sk-or-v1-envvalue99";

// Import AFTER env setup so module initialization fills only unset values.
const { keyValue } = await import(
	"../src/server/keys.ts"
);
const { authStore } = await import("../src/store/auth.ts");

const ENV_OWNED = "sk-or-v1-envvalue99";

after(() => {
	delete process.env.OPENROUTER_API_KEY;
	delete process.env.BRAVE_API_KEY;
	delete process.env.OPENAI_API_KEY;
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("boot fill-gap + precedence", () => {
	it("env-owned var wins and the file copy is untouched", () => {
		assert.equal(process.env.OPENROUTER_API_KEY, ENV_OWNED);
		assert.equal(authStore.authVars().OPENROUTER_API_KEY, "sk-or-v1-filefilefile", "file copy untouched");
		assert.equal(externalCliEnv().OPENROUTER_API_KEY, ENV_OWNED, "external CLIs retain launch-env ownership");
	});

	it("unknown file vars are reflected into the environment", () => {
		assert.equal(process.env.FUTURE_PLANS_TOKEN, "opaque-plans-token", "reflected at boot");
		assert.equal(externalCliEnv().FUTURE_PLANS_TOKEN, undefined, "external CLIs exclude unknown file-only injections too");
	});

	it("keyValue resolves env-first", () => {
		assert.equal(keyValue("OPENROUTER_API_KEY"), ENV_OWNED);
		assert.equal(keyValue("FUTURE_PLANS_TOKEN"), "opaque-plans-token");
		assert.equal(keyValue("BRAVE_API_KEY"), undefined);
	});
});


