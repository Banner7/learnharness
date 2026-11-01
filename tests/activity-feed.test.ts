/**
 * Activity-feed tests — the dock's composition (server/observability.ts):
 * cross-chat gathering, running-only filtering, title joins, oldest-first
 * ordering, and the server-side catalog/price join.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { PATHS } from "../config.ts";
import { activityFeed } from "../src/server/observability.ts";

test("activityFeed: running jobs across ALL chats, running-only, title-joined, oldest first", () => {
	const chatA = chatStore.createChat("feed chat A");
	const chatB = chatStore.createChat("feed chat B");
	// Track created ids: files run as concurrent processes over the shared data dir.
	const createdJobs: string[] = [];
	try {
		const jobA = jobStore.createJob({ kind: "research", chatId: chatA.id, toolCallId: "tc_a" });
		const jobB = jobStore.createJob({ kind: "demo", chatId: chatB.id, toolCallId: "tc_b" });
		const jobDone = jobStore.createJob({ kind: "research", chatId: chatA.id, toolCallId: "tc_done" });
		createdJobs.push(jobA.id, jobB.id, jobDone.id);
		jobStore.updateJob(jobDone.id, { status: "done" });
		const jobB2 = jobStore.createJob({ kind: "research", chatId: chatB.id, toolCallId: "tc_b2" });
		createdJobs.push(jobB2.id);
		// jobB2 is the MOST recently active → still sorts last (oldest-first).
		jobStore.updateJob(jobB2.id, { activity: "second step", updatedAt: new Date(Date.now() + 10).toISOString() });

		const feed = activityFeed();
		const feedJobs = feed.jobs.filter((j) => [jobA.id, jobB.id, jobB2.id].includes(j.id));
		assert.equal(feedJobs.length, 3); // done job filtered out
		assert.equal(feedJobs.find((j) => j.id === jobA.id)?.title, "feed chat A", "title join is the chat's title");
		const order = feedJobs.map((j) => j.id);
		assert.equal(order.indexOf(jobB2.id), order.length - 1);

		// extraction runs are absent when the pipeline is idle
		assert.deepEqual(feed.extractions, []);
	} finally {
		fs.unlinkSync(`${PATHS.chats}/${chatA.id}.json`);
		fs.unlinkSync(`${PATHS.chats}/${chatB.id}.json`);
		const jobsDir = path.join(PATHS.data, "jobs");
		for (const id of createdJobs) {
			fs.unlinkSync(path.join(jobsDir, `${id}.json`));
		}
	}
});

test("activityFeed: contextLimit is the server's live-catalog join (owner amendment, 2026-09-23)", () => {
	// keyed-provider federation needs a key in this process
	process.env.OPENROUTER_API_KEY ??= "test-key-openrouter-catalog";
	const chat = chatStore.createChat("limit join chat");
	const createdJobs: string[] = [];
	const usageFor = (model: string) => ({
		model,
		inputTokens: 1_000,
		outputTokens: 100,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		steps: 1,
	});
	try {
		const known = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_known" });
		const unknown = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_unknown" });
		const bare = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_bare" });
		createdJobs.push(known.id, unknown.id, bare.id);
		jobStore.updateJob(known.id, { usage: usageFor("openrouter:z-ai/glm-5.3-flash") });
		jobStore.updateJob(unknown.id, { usage: usageFor("nope/unknown") });

		const feed = activityFeed();
		const knownJob = feed.jobs.find((j) => j.id === known.id)!;
		// pi's catalog: glm-5.3-flash contextWindow 1_048_575
		assert.equal(knownJob.contextLimit, 1_048_575, "pi's catalog, joined server-side onto the feed");
		assert.ok(knownJob.costUsd !== null && Math.abs(knownJob.costUsd - 0.0002) < 1e-12, "Pi's price is projected on the server");
		const unknownJob = feed.jobs.find((j) => j.id === unknown.id)!;
		assert.equal(unknownJob.contextLimit, null, "missing from the live catalog → null, never a guessed window");
		assert.equal(unknownJob.costUsd, null);
		const bareJob = feed.jobs.find((j) => j.id === bare.id)!;
		assert.equal(bareJob.contextLimit, null, "no usage yet → no context line");
		assert.equal(bareJob.costUsd, null);
	} finally {
		fs.unlinkSync(`${PATHS.chats}/${chat.id}.json`);
		const jobsDir = path.join(PATHS.data, "jobs");
		for (const id of createdJobs) {
			fs.unlinkSync(path.join(jobsDir, `${id}.json`));
		}
	}
});
