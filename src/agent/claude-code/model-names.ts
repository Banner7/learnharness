import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { getClaudeBinary } from "./binary.ts";

/* Model names (fork, 2026-10-29): the picker showed the bare CLI aliases
   ("opus"), because Claude Code, not LearnHarness, decides which model an
   alias means. The CLI says so itself: its `initialize` control reply lists
   each alias with a description such as "Opus 5.5 · Best for everyday,
   complex tasks". That reply comes before any prompt, so asking costs no
   inference. The names are read once per server process (the CLI is pinned
   in the image, so they change only with a rebuild) and retried after a
   failure. Nothing here decides routing: turns still pass the alias. */

const PROBE_TIMEOUT_MS = 30_000;
const RETRY_AFTER_MS = 5 * 60_000;

let names: ReadonlyMap<string, string> = new Map();
let inFlight: Promise<void> | null = null;
let lastFailure = 0;

/** "Opus 5.5" for "opus", once the CLI has said so; otherwise undefined. */
export function claudeCodeModelLabel(alias: string): string | undefined {
	return names.get(alias);
}

/** The initialize reply's model list → alias → name. Only a description
 *  that starts with "<Name> <version>" is trusted; anything else is skipped
 *  so a changed CLI format falls back to the static names, never to junk. */
export function parseClaudeCodeModelNames(models: unknown): Map<string, string> {
	const out = new Map<string, string>();
	if (!Array.isArray(models)) return out;
	for (const entry of models) {
		if (!entry || typeof entry !== "object") continue;
		const { value, description } = entry as Record<string, unknown>;
		if (typeof value !== "string" || typeof description !== "string") continue;
		const head = description.split(" · ")[0]?.trim() ?? "";
		if (/^[A-Z][A-Za-z]* \d+(\.\d+)*$/.test(head)) out.set(value, head);
	}
	return out;
}

/** Start (or join) one read of the CLI's model names. Never throws. */
export function refreshClaudeCodeModelNames(env: () => NodeJS.ProcessEnv): Promise<void> {
	if (names.size > 0) return Promise.resolve();
	if (inFlight) return inFlight;
	if (Date.now() - lastFailure < RETRY_AFTER_MS) return Promise.resolve();
	inFlight = readNames(env())
		.then((read) => {
			if (read.size > 0) names = read;
			else lastFailure = Date.now();
		})
		.catch(() => {
			lastFailure = Date.now();
		})
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

type InitializeReply = {
	type?: unknown;
	response?: { request_id?: unknown; subtype?: unknown; response?: { models?: unknown } };
};

function readNames(env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
	const binary = getClaudeBinary();
	if (!binary) return Promise.resolve(new Map());
	// Executor form: the project's TypeScript lib predates Promise.withResolvers.
	let resolve!: (names: Map<string, string>) => void;
	const promise = new Promise<Map<string, string>>((settle) => {
		resolve = settle;
	});
	const id = randomUUID();
	const child = spawn(binary, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
		cwd: tmpdir(),
		env,
		stdio: ["pipe", "pipe", "ignore"],
	});
	let settled = false;
	let buffer = "";
	const timer = setTimeout(() => finish(new Map()), PROBE_TIMEOUT_MS);
	timer.unref();
	function finish(result: Map<string, string>): void {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		child.stdin.end();
		child.kill();
		resolve(result);
	}
	child.on("error", () => finish(new Map()));
	child.on("exit", () => finish(new Map()));
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let reply: InitializeReply;
			try {
				reply = JSON.parse(line) as InitializeReply;
			} catch {
				continue;
			}
			if (reply.type !== "control_response" || reply.response?.request_id !== id) continue;
			finish(reply.response.subtype === "success" ? parseClaudeCodeModelNames(reply.response.response?.models) : new Map());
		}
	});
	// No prompt follows: the process is killed as soon as the reply lands.
	child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "initialize" } })}\n`);
	return promise;
}
