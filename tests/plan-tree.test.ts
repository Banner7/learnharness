/**
 * Plan-tree tests: pure ops (src/core/plan-tree.ts), the plan_init tool
 * against the REAL chat store, the mermaid subset parser, and derived
 * statuses (progress derives from the transcript, never stored).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { derivePlanStatuses, derivedNodeStatus, type PlanTree, type PlanToolResult } from "../src/core/contracts.ts";
import { createTree, PlanTreeError } from "../src/core/plan-tree.ts";
import { planTools } from "../src/agent/tools/plan.ts";
import { parseMermaidPlan } from "../src/agent/tools/mermaid-plan.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

const N = (id: string, title = id) => ({ id, title });
const E = (from: string, to: string) => ({ from, to });

describe("plan-tree pure ops", () => {
	it("createTree builds version 1, stores no progress, and copies its inputs", () => {
		const nodes = [N("a", "A"), N("b", "B")];
		const edges = [E("a", "b")];
		const t = createTree(nodes, edges);
		assert.equal(t.version, 1);
		assert.ok(!("currentNodeId" in t) && !("doneNodeIds" in t), "structure only");
		assert.deepEqual(t.nodes.map((n) => n.id), ["a", "b"]);
		assert.deepEqual(t.edges, [E("a", "b")]);
		assert.deepEqual(nodes, [N("a", "A"), N("b", "B")]);
		assert.deepEqual(edges, [E("a", "b")]);
	});

	it("createTree rejects every invalid structure with a PlanTreeError", () => {
		for (const [nodes, edges, needle] of [
			[[N("a"), N("a")], [], /Duplicate node id "a"/],
			[[N("a")], [E("a", "ghost")], /unknown node id "ghost"/],
			[[N("a")], [E("ghost", "a")], /unknown node id "ghost"/],
			[[N("a")], [E("a", "a")], /self-loop/],
			[[N("a"), N("b")], [E("a", "b"), E("a", "b")], /already exists/],
			[[N("a"), N("b"), N("c")], [E("a", "b"), E("b", "c"), E("c", "a")], /cycle/],
			[[N("")], [], /non-empty `id`/],
			[[{ id: "a", title: "" }], [], /non-empty `title`/],
		] as const) {
			assert.throws(() => createTree([...nodes], [...edges]), (err: unknown) => err instanceof PlanTreeError && needle.test(err.message));
		}
	});
});

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

async function exec(tools: ReturnType<typeof planTools>, input: unknown): Promise<PlanToolResult> {
	return tools.plan_init!.execute("test", input).then((r) => r.details as PlanToolResult);
}

function newChat(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	return chat.id;
}

describe("plan_init (execute against the real store)", () => {
	it("parses a mermaid block, persists the tree, and a re-call replaces it wholesale", async () => {
		const chatId = newChat("Plan: init");
		const tools = planTools({ chatId, chatStore });
		const res = await exec(tools, {
			mermaid: "graph TD\n  primitives[Number primitives] --> operators[Arithmetic operators]\n  operators --> expressions[Evaluating expressions]\n  detour[Side quest]\n",
		});
		assert.equal(res.ok, true);
		assert.equal(res.tree!.version, 1);
		assert.deepEqual(res.tree!.nodes.map((n) => n.id), ["primitives", "operators", "expressions", "detour"]);
		assert.deepEqual(res.tree!.edges, [E("primitives", "operators"), E("operators", "expressions")]);
		assert.deepEqual(chatStore.getChat(chatId)!.tree, res.tree);

		const rewrite = await exec(tools, { mermaid: "graph TD\n  truth[The core truth]\n  goal[The sink] --> truth\n" });
		assert.equal(rewrite.ok, true);
		assert.deepEqual(chatStore.getChat(chatId)!.tree!.nodes.map((n) => n.id), ["truth", "goal"]);
	});

	it("parse and structural failures report every problem and persist nothing", async () => {
		const chatId = newChat("Plan: bad parse");
		const tools = planTools({ chatId, chatStore });
		const res = await exec(tools, { mermaid: "graph TD\n  Foo Bar[x] --> y\n  a --> a\n  subgraph hi\n" });
		assert.equal(res.ok, false);
		for (const line of [/line 2/, /line 3/, /line 4/]) assert.match(res.error!, line);
		assert.equal(res.tree, undefined);
		const cycle = await exec(tools, { mermaid: "graph TD\n  a[A] --> b[B]\n  b --> a\n" });
		assert.equal(cycle.ok, false);
		assert.match(cycle.error!, /cycle/);
		assert.equal(chatStore.getChat(chatId)!.tree, undefined, "nothing persisted on failure");
	});

	it("unknown chat returns ok:false", async () => {
		const res = await exec(planTools({ chatId: "chat_nonexistent", chatStore }), { mermaid: "graph TD\n  a[A]\n" });
		assert.equal(res.ok, false);
		assert.match(res.error!, /Chat not found/);
	});
});

describe("parseMermaidPlan (the constrained mermaid subset)", () => {
	const parse = parseMermaidPlan;

	it("accepts any graph/flowchart direction header, comments, and blank lines", () => {
		for (const header of ["graph TD", "graph td", "flowchart TB", "Flowchart td", "graph LR", "flowchart RL", "graph BT"]) {
			const res = parse(`${header}\n%% a comment\n\n  a[Alpha]\n`);
			assert.equal(res.ok, true, header);
			assert.deepEqual(res.plan!.nodes, [{ id: "a", title: "Alpha" }]);
		}
	});

	it("labels: bare ids, bracket, paren, quoted punctuation; the first label wins", () => {
		const res = parse('graph TD\n  bare\n  bracket[Bracket title]\n  paren("Paren title")\n  per_meal["Per-meal dose: ~20-40 g, excess = oxidized"]\n  bracket[Second label]\n');
		assert.deepEqual(res.plan!.nodes, [
			{ id: "bare", title: "bare" },
			{ id: "bracket", title: "Bracket title" },
			{ id: "paren", title: "Paren title" },
			{ id: "per_meal", title: "Per-meal dose: ~20-40 g, excess = oxidized" },
		]);
	});

	it("edges: endpoints register as nodes (forward refs fine), chains expand, synonyms and duplicates collapse", () => {
		const res = parse("graph TD\n  down[Later] --> up[Earlier]\n  a --> b[Bee] --> c\n  a ==> b\n  a -.-> b\n");
		assert.deepEqual(res.plan!.nodes.map((n) => n.id), ["down", "up", "a", "b", "c"]);
		assert.equal(res.plan!.nodes[0]!.title, "Later");
		assert.deepEqual(res.plan!.edges, [E("down", "up"), E("a", "b"), E("b", "c")]);
	});

	it("rejects non-slug ids with a message naming the id, self-loops, subgraphs, bad header, empty", () => {
		assert.match(parse("graph TD\n  Foo Bar[x]\n").problems[0]!, /line 2.*slug/);
		for (const src of ["graph TD\n  mps.translation[x]\n", "graph TD\n  a[Alpha] --> mps.translation[Beta]\n"]) {
			assert.match(parse(src).problems[0]!, /node id `mps.translation` must be a lowercase slug/);
		}
		assert.match(parse("graph TD\n  MPS[x]\n").problems[0]!, /node id `MPS` must be a lowercase slug/);
		for (const src of ["graph TD\n  a --> a\n", "graph TD\n  subgraph cluster\n", "digraph G\n  a\n", "%% only a comment\n"]) {
			assert.ok(!parse(src).ok, src);
		}
	});
});

describe("derivePlanStatuses (the map tracks position, not completion)", () => {
	const tree: PlanTree = {
		nodes: [N("a", "A"), N("b", "B"), N("c", "C")],
		edges: [E("a", "b"), E("b", "c")],
		version: 1,
	};
	type Part = { type: string; state: string; input: unknown; output?: unknown };
	const quiz = (state: string, nodeId: string | undefined, correct?: boolean): Part => ({
		type: "tool-quiz",
		state,
		input: nodeId === undefined ? {} : { nodeId },
		...(correct === undefined ? {} : { output: { correct } }),
	});
	const explain = (nodeId: string | undefined): Part => ({ type: "tool-explain", state: "output-available", input: nodeId === undefined ? {} : { nodeId } });
	const derive = (parts: Part[], t = tree) => derivePlanStatuses(t, parts.map((p) => ({ parts: [p] })));

	it("current = the most recent tagged call, regardless of state or outcome; visited = earlier ones", () => {
		const cases: Array<[Part[], string | null, string[]]> = [
			[[], null, []],
			[[quiz("output-available", "b", false)], "b", []],
			[[quiz("input-available", "c")], "c", []],
			[[quiz("output-available", "a", true)], "a", []],
			[[quiz("output-available", "a", true), quiz("output-available", "b", true)], "b", ["a"]],
			[[quiz("output-available", "a", true), quiz("output-available", "b", true), quiz("input-available", "a")], "a", ["a", "b"]],
			[[quiz("output-available", "a", true), quiz("output-available", "a", false)], "a", []],
			[[quiz("output-available", undefined, true), quiz("output-available", "ghost", true), explain(undefined)], null, []],
			[[explain("a"), explain("b")], "b", ["a"]],
			[[quiz("output-available", "a"), explain("b")], "b", ["a"]],
		];
		for (const [parts, current, visited] of cases) {
			const st = derive(parts);
			assert.equal(st.current, current);
			assert.deepEqual([...st.visited].sort(), visited);
		}
	});

	it("a rewritten map derives against the CURRENT tree — dropped slugs stop counting", () => {
		const st = derive([quiz("output-available", "a", true), quiz("output-available", "c", true)], { ...tree, nodes: [tree.nodes[0]!, tree.nodes[1]!] });
		assert.equal(st.current, "a");
		assert.equal(st.visited.size, 0);
	});

	it("derivedNodeStatus: current wins over visited; upcoming otherwise", () => {
		const st = derive([quiz("output-available", "a", true), quiz("output-available", "b", true)]);
		assert.equal(derivedNodeStatus(st, "a"), "visited");
		assert.equal(derivedNodeStatus(st, "b"), "current");
		assert.equal(derivedNodeStatus(st, "c"), "upcoming");
	});
});
