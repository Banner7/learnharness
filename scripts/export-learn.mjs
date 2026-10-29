#!/usr/bin/env node
/** Export LearnHarness session snapshots as readable Markdown.
 * Usage: node scripts/export-learn.mjs <LH_DATA_DIR> <export-directory>
 * Run on the machine holding both directories.
 * Originals in LH_DATA_DIR remain the authoritative, restorable record.
 */
import { readFile, readdir, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

const [dataDir, exportDir] = process.argv.slice(2);
if (!dataDir || !exportDir) {
	console.error("Usage: node scripts/export-learn.mjs <LH_DATA_DIR> <export-directory>");
	process.exitCode = 2;
} else {
	const exportRoot = path.resolve(exportDir);
	const dataRoot = path.resolve(dataDir);
	const outputDir = path.join(exportRoot, "lh");
	const inputDir = path.join(dataRoot, "chats");
	if (exportRoot === dataRoot || exportRoot.startsWith(`${dataRoot}${path.sep}`) || dataRoot.startsWith(`${exportRoot}${path.sep}`)) {
		throw new Error("Input and output directories must not be nested");
	}
	await mkdir(outputDir, { recursive: true });
	let exported = 0;
	const links = [];
	let files;
	try {
		files = (await readdir(inputDir)).filter((name) => /^chat_[A-Za-z0-9_-]+\.json$/.test(name)).sort();
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		// An absent chats mount must not erase previously exported sessions.
		const existing = await readdir(outputDir);
		if (existing.some((name) => /^chat_[A-Za-z0-9_-]+\.md$/.test(name))) {
			throw new Error(`Missing chats directory while exported sessions exist: ${inputDir}`);
		}
		files = [];
	}
	const sessionIds = new Set();
	for (const file of files) {
		const chat = JSON.parse(await readFile(path.join(inputDir, file), "utf8"));
		if (!Array.isArray(chat.messages) || !chat.messages.length) continue;
		sessionIds.add(path.parse(file).name);
		const lines = [
			`# ${String(chat.title ?? "Untitled session").replace(/[\r\n]/g, " ")}`,
			"",
			`- Session: ${chat.id}`,
			`- Type: ${chat.kind ?? "teach"}`,
			`- Started: ${chat.createdAt}`,
			`- Updated: ${chat.updatedAt}`,
			"",
		];
		// Upstream 0.3.8 (#102) delivers Claude's teaching through the
		// send_to_user tool, not text parts (fork port, 2026-10-26). Mirrors
		// userFacingTextOf/failedOutputCallIds in src/core/native-messages.ts:
		// failed or aborted output calls were never delivered.
		const failedOutput = new Set();
		for (const message of chat.messages) {
			if (message.role === "toolResult" && message.toolName === "send_to_user" && message.isError) failedOutput.add(message.toolCallId);
			else if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted") && Array.isArray(message.content)) {
				for (const part of message.content) if (part.type === "toolCall" && part.name === "send_to_user") failedOutput.add(part.id);
			}
		}
		for (const message of chat.messages) {
			if (message.role === "user" && typeof message.content === "string") {
				lines.push("## Learner", "", message.content, "");
			} else if (message.role === "assistant" && Array.isArray(message.content)) {
				const text = message.content
					.map((part) => part.type === "text" ? part.text
						: part.type === "toolCall" && part.name === "send_to_user" && !failedOutput.has(part.id) ? part.arguments?.message
						: undefined)
					.filter((t) => typeof t === "string" && t.trim())
					.join("\n\n");
				if (text) lines.push("## Tutor", "", text, "");
			} else if (message.role === "toolResult" && message.details?.questionText) {
				const answer = message.details;
				lines.push("## Answer", "", String(answer.questionText), "");
				const selected = answer.dontKnow ? "I don't know" : answer.text ?? answer.other ?? answer.answers?.map((item) => item.label).join(", ") ?? "";
				lines.push(`- Response: ${selected}`);
				if (typeof answer.confidence === "number") lines.push(`- Confidence: ${answer.confidence}%`);
				if (typeof answer.correct === "boolean" && !answer.dontKnow) lines.push(`- Correct: ${answer.correct ? "yes" : "no"}`);
				if (answer.thinking ?? answer.note) lines.push(`- Reasoning: ${answer.thinking ?? answer.note}`);
				if (answer.readingThinking) lines.push(`- While reading: ${answer.readingThinking}`);
				lines.push("");
			}
		}
		const destination = path.join(outputDir, `${path.parse(file).name}.md`);
		links.push(`- [[lh/${path.parse(file).name}|${String(chat.title ?? "Untitled session").replace(/[\r\n|[\]]/g, " ")}]] — ${chat.updatedAt}`);
		exported++;
		const content = `${lines.join("\n").trimEnd()}\n`;
		const tmp = `${destination}.${process.pid}.tmp`;
		await writeFile(tmp, content, { mode: 0o600 });
		await rename(tmp, destination);
	}
	// Only the generated chat_*.md namespace is mirrored on deletion.
	for (const name of await readdir(outputDir)) {
		if (/^chat_[A-Za-z0-9_-]+\.md$/.test(name) && !sessionIds.has(path.parse(name).name)) {
			await unlink(path.join(outputDir, name));
		}
	}
	const graphPath = path.join(path.resolve(dataDir), "graph", "nodes.jsonl");
	let lines;
	try {
		lines = (await readFile(graphPath, "utf8")).split("\n").filter(Boolean);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		lines = [];
	}
	const nodes = new Map();
	for (const line of lines) {
		const node = JSON.parse(line);
		const previous = nodes.get(node.id);
		if (!previous) nodes.set(node.id, node);
		else {
			const source = new Map([...previous.provenance, ...node.provenance].map((point) => [`${point.chatId}/${point.messageId}`, point]));
			previous.provenance = [...source.values()];
		}
	}
	if (nodes.size) {
		const graphNote = ["# LearnHarness propositions", "", "These are claims extracted from sessions, not mastery ratings.", ""];
		for (const node of nodes.values()) {
			graphNote.push(`## ${node.name}`, "", node.statement, "", `Source: ${[...new Set(node.provenance.map((point) => point.chatId))].map((id) => sessionIds.has(id) ? `[[lh/${id}|${id}]]` : id).join(", ")}`, "");
		}
		await writeFile(path.join(outputDir, "Propositions.md"), `${graphNote.join("\n").trimEnd()}\n`, { mode: 0o600 });
	}
	const index = ["# LearnHarness sessions", "", ...links, ...(nodes.size ? ["", "- [[lh/Propositions|Extracted propositions]]"] : []), ""].join("\n");
	await writeFile(path.join(outputDir, "index.md"), index, { mode: 0o600 });
	console.log(`Exported ${exported} sessions and ${nodes.size} propositions into ${outputDir}`);
}
