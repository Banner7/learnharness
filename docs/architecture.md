# Learning Harness — Architecture

Status: **architecture and historical implementation record**, audited 2026-09-18. Core/server layering, graph ledgers, extraction and practice contracts remain relevant. Earlier graph-canvas, question-dock, desktop-layout and shortcut passages are historical: this browser-only fork uses a topic composer, inline transcript questions, overlay sidebar and Settings sheets at every width. Electron packaging is removed. The pre-audit spec is archived at [`archive/architecture-2026-09-08.md`](archive/architecture-2026-09-08.md).

**What this is.** A browser-only Next.js learning app whose persistent knowledge graph stores propositions and reasoning chains from tutoring sessions. A teacher agent authors a formal session plan tree and verifies understanding with structured questions. The graph is data consumed by teaching and practice.

**Design principles, in priority order:**

1. **Maximum control.** Every dependency edge is explicit and machine-checked. Nothing reaches sideways for convenience.
2. **Easy editability.** A worker can trace any behavior to one file. Layers are named by responsibility, not by framework accident.
3. **Zero technical debt.** The shape you see is the shape that runs. Deprecated paths are deleted, not parked.
4. **Crystal-clear architecture.** Two barrels as the entire public API, two composition roots, one writer per store, named seams. When a rule can be a lint rule, it is.

**The one-sentence model:** a pure domain core at the center; every external effect (fs, LLMs, browser, OS) behind an adapter at the edge; two composition roots as the only places the edges are plugged together; and every persistent store written by exactly one system.

---

## 1. Two axes, one law

Hold the architecture along two orthogonal axes:

**Static structure — the hexagon.** One pure core (`src/core`); everything else is an *adapter* (implements a core port or drives the core) or a *composition root* (the only code that wires adapters to core). Dependency arrows point **inward only** — toward purity, toward stability. Two barrels are the entire public API: `@/src/core` (browser-safe) and `@/src/server` (the server-side surface).

**Runtime ownership — six systems.** Each persistent store has exactly one owning writer-system; systems talk only through named, idempotent protocols:

| System | Owns (sole writer) | Role |
|---|---|---|
| **Classroom** — session engine | `data/chats/*.json` | the turn pipeline, prober→teacher, plan tree, questions, phases |
| **Workbench** — background labor | `data/jobs/*.json` | job runner, researcher/demo-builder/visual-maker, steer delivery |
| **Library** — world model | `data/graph/*` ledgers | extraction pipeline (sole graph writer), derivation, birth-session clusters |
| **Practice** — problem sets | `data/practice/*.json` | partitioner→generator→grader pipeline, self-contained sets (§7) |
| **Stage** — presentation shell | nothing server-side | phone UI at every width: home topic composer, inline transcript questions, overlay sidebar, Settings sheets — pure consumer via `/api/*` |
| **Machine room** — host | process + config | standalone Next server, `config.ts`, data-dir seam, server credential files/env |

**The unifying law** (generates everything else): **imports point inward, writes point to append-only evidence, and everything else is derived.** Dependency flows toward purity; data flows toward evidence; no state is stored where it can be recomputed.

---

## 2. The layers and the import law

Dependency arrows point **down only**. Each layer may import the core barrel; nothing skips a boundary for convenience.

```
┌──────────────────────────────────────────────────────────────┐
│ SHELL      app/            Next.js route handlers (transport) │
│            components/     session + home UI (render only)    │
├──────────────────────────────────────────────────────────────┤
│ SERVER     src/server      composition roots (stores.ts,      │
│            chat-handler.ts) + named service seams + the      │
│            pi engine bridge. Zero business logic              │
├──────────────────────────────────────────────────────────────┤
│ AGENT      src/agent       prober + teacher loops, tool       │
│            surfaces, prompt fragments, sub-agents, the       │
│            extraction pipeline. Deps arrive via factories —  │
│            never imported from below                          │
├──────────────────────────────────────────────────────────────┤
│ CORE       src/core        pure domain: contracts (6 domains),│
│            ports, merger + derivation, coverage, question-   │
│            core, plan-tree, phases, layout, prices. No IO     │
│            (two files use node:crypto — pure                  │
│            but node-bound, hence kept out of the barrel)      │
├──────────────────────────────────────────────────────────────┤
│ STORE      src/store       fs adapters: chats · graph        │
│            ledgers · jobs (implement core ports) + two       │
│            portless settings adapters. The ONLY modules     │
│            that touch data/                                   │
└──────────────────────────────────────────────────────────────┘
```

**The import law** (`eslint.config.mjs` — the config's sole job; four `import/no-restricted-paths` zones, all `"error"`; each verified to fire; `lint` is a gate on every change):

| Zone | May import | Rationale |
|---|---|---|
| `components/**` | `@/src/core` only (the barrel) | The UI renders domain data; it never runs domain logic or touches IO |
| `app/**` | `@/src/core` + `@/src/server` (the barrels) | Route handlers are transport; they delegate to server entry points |
| `src/core/**` | nothing below itself (never `agent`/`server`/`store`) | The core is pure; adapters implement its ports, never the reverse |
| `src/agent/**` | never `server`/`store` | The agent layer receives its dependencies (ports, engines, seams) via factories/closures |

```mermaid
flowchart TB
    subgraph SHELL["SHELL — render + transport, no domain logic"]
        APP["app/ — pages + 28 API route handlers"]
        COMP["components/ — phone session + home UI"]
    end

    subgraph SERVER["SERVER — src/server — composition + seams"]
        SBAR["barrel index.ts — THE server surface"]
        ROOTS["composition roots: stores.ts (storage) · chat-handler.ts (turn)"]
        SEAMS["service seams: turn-service · jobs (wake) · turn-liveness · observability · model-catalog · settings-body"]
        PIB["pi/ — engine bridge: record-adapter (record → pi messages) · ui-stream (pi events → SSE)"]
    end

    subgraph AGENT["AGENT — src/agent — LLM loops, deps injected"]
        TEACH["prober + teacher agents · tools · prompt fragments"]
        SUBS["sub-agents: researcher · demo-builder · visual-maker"]
        PIPE["extraction pipeline"]
    end

    subgraph CORE["CORE — src/core — pure domain, zero IO"]
        CONTRACTS["contracts/ — 6 domains: plan · graph · chat · jobs · probe · models"]
        PORTS["ports.ts — ChatStore · GraphStore · JobStore (types only)"]
        BRAIN["merger + derivation · coverage · question-core · plan-tree · phases · prices · tool-parts"]
        CBAR["barrel index.ts — browser-safe exports ONLY"]
    end

    subgraph STORE["STORE — src/store — fs adapters, only data/ writers"]
        ADP["chats.ts · graph.ts · jobs.ts (implement core ports)"]
    end

    CFG["config.ts — leaf facts: PATHS · LEDGER_FILES · engine-construction facts (no models — BYOK slots own those)"]

    COMP -->|"lint zone: @/src/core only"| CBAR
    APP -->|"lint zone: @/src/core + @/src/server"| CBAR
    APP -->|"lint zone: @/src/core + @/src/server"| SBAR
    SBAR --> ROOTS
    SBAR --> SEAMS
    ROOTS -->|"instantiates + passes ports"| ADP
    ROOTS -->|"factory calls, ports injected"| TEACH
    ROOTS -->|"factory calls, ports injected"| PIPE
    SEAMS --> PIB
    TEACH --> CONTRACTS
    TEACH --> BRAIN
    SUBS --> CONTRACTS
    PIPE --> BRAIN
    ADP -->|"implement"| PORTS
    ADP --> CFG
    CBAR --> CONTRACTS
    CBAR --> PORTS
    CBAR --> BRAIN
    SERVER --> CFG
    AGENT --> CFG

    CORE -.->|"✗ FORBIDDEN (lint)"| SERVER
    AGENT -.->|"✗ FORBIDDEN (lint)"| SERVER
    COMP -.->|"✗ FORBIDDEN (lint)"| SERVER
```

**Two rules are documentation-only by design.** The ESLint plugin's `except` cannot express "all but one", so `src/server/stores.ts` is intended to be the only server module importing adapters, with documented adapter exceptions. Browser-safety of the core barrel is a doc-comment convention (see §2.1). Tests import freely across layers; scripts act as extra composition roots.

### 2.1 The core barrel and browser-safety

`src/core/index.ts` exports only browser-safe modules — pure logic + types, no node builtins, no fs, no network. Server-only graph derivation (`graph.ts` and `coverage.ts`, which need `node:crypto`) and provenance grouping (`session-clusters.ts`) stay outside the barrel. Port types are types-only and safe to re-export. The shared core serves browser grading, plan statuses and cost folding alongside server merger, derivation and coverage.

### 2.2 Contracts — one file per domain

`src/core/contracts.ts` is a barrel over seven domain files, each owned outright by its stream (schema changes in a domain you don't own go through the master session):

- `contracts/plan.ts` — plan tree types + derived statuses (`derivePlanStatuses`)
- `contracts/graph.ts` — graph domain: ledgers, findings/audit shapes, snapshot, birth-session clusters
- `contracts/chat.ts` — session records, usage/money channel, settings, handoff text
- `contracts/jobs.ts` — the ack-and-steer protocol: job records, steer message builders, deterministic steer ids, usage accumulation
- `contracts/probe.ts` — probe assessment + the shared zod schema
- `contracts/models.ts` — client-safe model-catalog shapes
- `contracts/practice.ts` — problem sets, reasoning chains, params, grade scores

---

## 3. Ports, adapters, and the composition roots

Storage is **per-entity semantic ports**, never one generic interface: `ChatStore`, `GraphStore`, `JobStore`, `PracticeStore` (`src/core/ports.ts` — types only). The fs adapters (`src/store/{chats,graph,jobs,practice}.ts`) implement them and contain persistence and nothing else.

**Idioms.** Graph evidence lives in **append-only JSONL ledgers** (corrupt-line-tolerant reads; strict shape guards drop invalid lines, never guess). Chats, jobs, sources, and settings blobs are whole-file read-modify-write JSON. All writes are synchronous, single-process (atomicity rides the Node event loop). Merge/dedup/derivation semantics are **reader-side, in core** — the store never decides.

- **`src/server/stores.ts` is THE composition root for storage**: it instantiates adapters and hands port objects to everything else (chat-handler, job runner, extraction pipeline, practice pipeline, graph/chats routes, turn services). It is the single place a storage decision (JSON vs SQLite, local vs remote) gets re-made.
- **`src/server/chat-handler.ts` is THE composition root for a turn**: it wires the stores, the job runner, the extraction pipeline, the practice pipeline, and the pi engine into the stream response (`setTurnRunner`/`setJobRespawn` register its seams for the wake pipeline). All logic lives behind the seams it calls.
- The agent layer is dependency-inverted throughout: `createJobRunner({ chatStore, jobStore, deliver })`, `createExtractionPipeline({ chatStore, graphStore, extractor?, auditor?, embedder })`, `createTeacherTools({ chatId, chatStore, jobStore, spawn })`, `createProberAgent`/`createTeacherAgent(engine?, tools?, …)`. Tests inject the same ports production wires — or swap an in-memory port.

The engine side is adapted too: `src/agent/models.ts` (`piEngineFor`) resolves each role's engine from the user's **model slots** (BYOK: `settings.json` `models` section — strong/cheap/vision; a chain that ends empty refuses honestly with 503 `models_not_configured`) — and the teacher/prober conversation runs the **SESSION'S OWN record**: `POST /api/chats` stamps every newborn verbatim from the strong slot (the new-session default, chosen in setup), in-session picks write the session's record (`PUT /api/chats/:id/settings`), and the strong slot never reaches an existing session again (legacy unstamped records fall back to it at resolve time) — per-session models, owner 2026-09-28. Beyond the conversation, `src/server/pi/` bridges the two SDK worlds: `record-adapter.ts` (persisted UIMessage record → stateless pi `Message[]`, dangling tool calls get synthesized INTERRUPTED results) and `ui-stream.ts` (pi agent events → AI-SDK UIMessage SSE).

```mermaid
flowchart LR
    subgraph DRIVING["DRIVING ADAPTERS — inbound"]
        BROWSER["Browser UI — components/: inline questions (addToolOutput) · topic composer · overlay sidebar"]
        HTTP["HTTP transport — app/api/* route handlers"]
        NOTES["Notes front door — POST /api/graph/import"]
        HOST["Standalone Next server — LH_DATA_DIR + server credentials"]
    end

    subgraph HEXCORE["THE CORE — src/core (pure domain)"]
        direction TB
        SESS["session brain: phases · plan-tree · question-core · pending · steer builders"]
        GBRAIN["graph brain: merger + derivation · coverage · clusters · layout"]
        PORTSBOX["PORTS (types only): ChatStore · GraphStore · JobStore · PracticeStore"]
    end

    subgraph DRIVEN["DRIVEN ADAPTERS — outbound"]
        FS["fs stores — src/store (data/)"]
        LLM["LLM engines — pi-ai/OpenRouter via piEngineFor"]
        HEAD["headless Chrome — demo verify · SVG render"]
        WEB["web tools — Google CSE + Readability/Jina (researcher)"]
    end

    BROWSER --> HTTP
    NOTES --> HTTP
    ELEC --> HTTP
    HTTP --> SESS
    HTTP --> GBRAIN
    SESS --> PORTSBOX
    GBRAIN --> PORTSBOX
    PORTSBOX --> FS
    SESS --> LLM
    GBRAIN --> LLM
    SESS --> HEAD
    SESS --> WEB
```

---

## 4. The six systems (runtime ownership and protocols)

The systems view: each box owns its store; edges are the protocols, each with the adapter/seam that implements it.

```mermaid
flowchart TB
    LEARNER["the learner"]

    subgraph STAGE["STAGE — presentation shell (owns nothing server-side)"]
        UI["phone UI at every width · inline transcript questions · topic composer · plan · activity · overlay sidebar · Settings sheets"]
    end

    subgraph CLASSROOM["CLASSROOM — session engine (owns data/chats)"]
        TURN["turn pipeline — handleChatRequest"]
        AGENTS["prober → teacher (stateless per-turn, from the record)"]
        CHATDATA["chat records — data/chats/*.json"]
    end

    subgraph WORKBENCH["WORKBENCH — background labor (owns data/jobs)"]
        JOBRUN["job runner"]
        SUBAGENTS["researcher · demo-builder · visual-maker"]
        WAKE["wake pipeline — per-chat serialized queues on globalThis"]
    end

    subgraph PRAC["PRACTICE — problem sets (owns data/practice)"]
        PPART["practice pipeline — partitioner → one generator per problem · one grader per answer<br/>(score-only; never steers the teacher)"]
        PDATA["problem sets — data/practice/*.json"]
    end

    subgraph LIBRARY["LIBRARY — world model (owns data/graph ledgers)"]
        EXTRACT["extraction pipeline — extractor → auditor → merger (SOLE graph writer, serial per source)"]
        DERIVE["derivation — graphSnapshot · birth-session clusters (reads, never write)"]
        GRAPHDATA["append-only ledgers — data/graph/*.jsonl"]
    end

    subgraph ROOM["MACHINE ROOM — host"]
        HOST["Standalone Next server · config.ts · LH_DATA_DIR · server credentials"]
    end

    LEARNER -->|"text · answers [transport adapter]"| UI
    UI -->|"POST /api/chat [question answers ride addToolOutput]"| TURN
    TURN -->|"quiz / ask_user_question stream to browser [client-question tools, no execute]"| UI
    TURN -->|"saveMessages · persistTurn [ChatStore port]"| CHATDATA
    TURN -->|"spawn(job) — fire-and-forget ack [job tools + JobStore port]"| JOBRUN
    JOBRUN --> SUBAGENTS
    SUBAGENTS -->|"result → steer message [steer builders in core/jobs.ts]"| WAKE
    WAKE -->|"exactly-once wake turn [turnRunner seam → same handleChatRequest]"| TURN
    TURN -->|"triggerExtraction when uncoveredTokens ≥ chunkTokens [trigger seam, single-flight]"| EXTRACT
    EXTRACT -->|"reads transcript as evidence [ChatStore port]"| CHATDATA
    EXTRACT -->|"append-only ledger writes [GraphStore port — sole writer]"| GRAPHDATA
    DERIVE -->|"pure read: graph data and birth-session clusters [graphSnapshot]"| GRAPHDATA
    UI -->|"POST /api/practice/sets · answers [HTTP transport]"| PPART
    PPART -->|"reads the graph ONCE at creation — propositions+chains frozen into the set [GraphStore port, pure read]"| GRAPHDATA
    PPART --> PDATA
    UI -->|"GET /api/graph (read) · POST import"| DERIVE
    HOST -.->|"hosts every server-side system"| TURN
```

Four server-side systems, each the sole writer of its own store, connected by named protocols: the **turn request** (Stage→Classroom), the **ack-and-steer** loop (Classroom→Workbench→Classroom), the **extraction trigger + transcript read** (Classroom→Library), and the **practice request** (Stage→Practice over HTTP, plus Practice's one-time graph snapshot read at creation). The Stage touches systems only through the thin HTTP transport; the teacher reaches the Library directly through the gated prober tools (`list_sessions` / `list_propositions`) rather than any injected context.

---

## 5. The session (one chat turn)

`handleChatRequest` is framework-free (plain `Request`/`Response`) with a `buildAgent` test seam so tests drive it with scripted engines. The turn, in exact order:

```mermaid
sequenceDiagram
    participant B as Browser (useChat)
    participant R as POST /api/chat
    participant H as handleChatRequest
    participant L as turn-liveness (globalThis)
    participant CS as chatStore adapter
    participant A as prober/teacher agent (pi engine)
    participant F as onFinish seams

    B->>R: messages (+ graded question output via addToolOutput)
    R->>H: handleChatRequest(req)
    H->>L: beginTurn(chatId)
    Note over H,L: already running → 409; retryingFetch waits, re-fetches<br/>the record, merges unsent client messages by id, re-POSTs
    H->>H: claimSteers — coalesce queued steers into outgoing
    H->>CS: saveMessages (write-ahead: persist even before the stream)
    H->>A: build agent from record (probe_done part in transcript ⇒ teacher)
    Note over H,A: recordToPiMessages: stateless rebuild; dangling<br/>tool calls get synthesized INTERRUPTED results
    A-->>B: SSE stream (ui-stream bridge)
    Note over B: quiz / ask_user_question have NO server execute:<br/>rendered in the dock; graded client-side via question-core
    B->>B: QuestionDock: parse → shuffle (seeded) → buildAnswer (grade)
    B->>R: continuation (sendAutomaticallyWhen fires)
    A-->>F: onFinish
    F->>CS: persistTurn (canonical, idempotent) + appendTurnUsage
    F->>F: triggerExtraction — if uncovered tokens ≥ chunkTokens, fire async
    F->>L: endTurn (ALWAYS last — the registry never locks)
```

- **Client-side question tools** (`quiz`, `ask_user_question`) have no server execute: the call streams to the browser, the learner answers in the dock, the client grades via `question-core` and returns the verdict with `addToolOutput`, which fires the continuation. A pending quiz persisted in the record is exactly what makes **resume mid-question free**. Deterministic seeded shuffling (keyed by toolCallId) keeps server and client renders identical.
- **The prober→teacher handoff**: the first turn(s) run the prober (floor/ceiling via quiz, goal via ask); `probe_done` (server-executed) files the assessment and queues a handoff steer; from the first `tool-probe_done` part in the transcript, the handler builds the teacher agent for every later turn. Phases (`core/phases.ts`) fold strictly: probe → plan → teach.
- **The formal plan tree is author-once**: the teacher authors the session's dependency map with a single schema-validated `plan_init` tool (a mermaid-subset graph, parsed deterministically with line-numbered errors, validated as a DAG). Progress is never mutated — statuses (`current`/`visited`/upcoming) are **derived** from tagged quiz calls in the transcript; the tree panel and the plan blocks render that derivation.
- **Job tools are server-executed, ack-and-steer**: `research`/`demo`/`visual` resolve immediately mid-turn with a fire-and-forget ack (the teacher keeps teaching); `spawn(job, input)` fires the background runner.
- Turn services are named seams taking explicit dependencies. Extraction contains its errors, but **canonical persistence must not fail silently**: a failed input write refuses acceptance without starting an agent; `persistTurn` throws on a failed reply write. The runner reports settlement failure before `[DONE]` and releases liveness even when normal settlement fails. Steer reconciliation uses the durable record, so a later bookkeeping failure cannot replay already-saved learner input.
- **Late attachment must still see settlement failure.** A small, memory-only notice per session precedes the settled stream terminal when the failing turn has already left the live registry. The next accepted turn, successful session deletion, or server exit clears it. Reopening seeds the existing banner from that notice and waits for ordinary learner input; dismissing the banner is not permission to automatically retry the model. No synthetic failure entry is added to the saved transcript.
- **Recovery never blindly resends an answer.** Submitted question drafts survive optimistic unmount in memory; the existing Submit action reconciles uncertain acceptance against the canonical record and running-turn state before sending again. EOF or a rejected stream read without a terminal triggers one read-only reattachment; another transport failure shows the existing error banner rather than claiming completion. Explicit completion, cancellation, and the literal-final-entry saved-error rule remain unchanged.

### 5.1 The wake pipeline (Workbench → Classroom)

**Worker completion and session delivery are separate lifecycles.** Dispatch persists the tool input on the job before spawning. On completion, the runner saves its result, terminal worker status (`done`/`error`), and `delivery: {kind: "result", status: "pending"}` in one job-record update. It then queues the native custom **steer message** without awaiting delivery. Its content is model-facing text; details carry the UI artifact. Worker resources are released and the Background agents row disappears even if an unanswered question holds the result indefinitely. Dispatch cards say “finished,” not “delivered.” Only computing workers can be aborted; abort saves an independent pending abort notice.

```mermaid
flowchart TB
    R["save worker outcome + pending delivery; release worker"] --> ENQ["one registry entry per steer ID, including wake cargo"]
    ENQ --> LIVE{"live agent and background consent?"}
    LIVE -->|yes| STEER["pi steering at native boundaries; answer run takes parked results"]
    LIVE -->|no| GATE["wait for turn-free, question-free, unpaused, consented session"]
    GATE --> RUN["idle wake through the normal turn composition"]
    RUN -->|"409"| BACKOFF["existing backoff 500→1000→2000→5000ms"]
    BACKOFF --> GATE
    RUN -->|"403"| HOLD["retain ownership until consent permits delivery"]
    RUN -->|"other failed start"| QUIET["quiet pending; next learner run or restart recovery"]
    RUN --> SAVE["canonical marker persistence, not merely HTTP 200"]
    STEER --> SAVE
    SAVE --> FIN["acknowledge delivery; worker outcome unchanged"]
    CRASH["lazy recovery + live-agent registration restore known pending jobs"] --> ENQ
```

The per-chat registry retains ownership across live handoff, idle-wake flight, and 409/403 return; repeated submissions share one entry/promise. A deterministic marker ID in the **saved conversation** completes delivery. Streaming visibility alone does not. A failed bookkeeping acknowledgement cannot replay a saved marker, and later teaching/model failure does not reopen delivery or retry the accepted turn. Failed starts leave results durably pending without a new error UI or retry timer; the in-memory entry stays parked until a learner run or process restart. Normal question/dismissal waits and consent deferrals are not failures.

Recovery reads saved job input before legacy transcript lookup. Missing research questions fail honestly without invoking the researcher. Legacy running jobs with saved results become finished workers with pending delivery; legacy terminal jobs without delivery metadata remain untouched, rather than guessing that old outcomes should be replayed. Pending result and abort notices are restored before a newly registered agent's first steering poll, even without a preceding jobs-feed read. Deleting a session discards its pending delivery obligations; only live turns and computing workers block deletion. These guarantees use the existing JSON storage and single-process delivery registry, not a transactional queue or a promise of exactly-once model execution.

Sub-agents **verify, never one-shot**: the demo-builder headlessly executes its HTML in system Chrome before delivery; the visual-maker renders each SVG and looks at it (needs a vision-capable model — the `vision` slot in settings).

---

## 6. The knowledge graph — two channels, one writer

**The extraction pipeline is the sole graph writer.** Nothing else appends to `data/graph/*.jsonl` — not the teacher, not the server, not a migration script. Backfill scripts bypass this by design as one-time operations; graph-view positions no longer exist.

```mermaid
flowchart TB
    TRIG["trigger seam (turn-service): coverageOf(record, coverageLedger)<br/>— uncovered tokens ≥ graph.extractionChunkTokens (settings)?"] -->|"yes, single-flight per source"| RUN["extraction.runExtraction(chatId)"]
    IMPORT["POST /api/graph/import (notes front door)<br/>deterministic src id = sha256(path); content-fp guard skips unchanged re-imports"] -->|"importNotes: shared pipeline, per-door preambles"| RUN
    RUN --> BATCH["batchRuns — greedy token-budgeted batches of oldest uncovered TEACHER-PROSE messages"]
    EXT["EXTRACTOR (LLM) — sees ONLY the teacher-prose view (tree-blind, graph-blind)<br/>submits propositions + REASONING CHAINS (owner redesign, 2026-09-30)<br/>stored AS-IS — chains.jsonl is the truth (chains-primary, 2026-09-30)"]
    EXT --> AUD["AUDITOR (LLM, agentic loop) — sees findings ONLY, never the source;<br/>explores the graph via find / list_sessions / list_propositions tools,<br/>judges identity ONLY (link-or-create, equivalence bias) — sees propositions, never mints chains"]
    AUD --> MERGE["MERGER (deterministic, core/graph.ts) — the ONLY ledger writer:<br/>identity via validated linkTo · chain dedupe (premises+conclusion → one arg_ id) · coverage checkpoint"]
    MERGE --> DATA["persist propositions, chains and coverage in graph ledgers"]
    MERGE -->|"failure at ANY stage"| NOTHING["checkpoints nothing — the next trigger re-runs"]
```

**Raw reasoning chains only** (2026-09-27 cleanup; teacher-prose view 2026-09-28): the extractor reads ONLY the session — and since the 2026-09-28 ruling, ONLY the teacher agent's prose: plain paragraphs under the session title, no learner messages, no thinking, no tool calls or results, no quiz blocks. Coverage fingerprints, slot tokens, and batch budgets all derive from that same selection (`messageViewLines` in `core/coverage.ts`), so "covered" is exactly "what the extractor saw" — a quiz answer or learner edit can never open a run, and only a teacher-prose edit re-opens its message. The old call+result inseparability bond is deleted (nothing left to keep together); batching is pure greedy fill. The shared markdown engine (`core/session-markdown.ts`) keeps the full session format for the future user-facing export and is no longer used by extraction. The extractor's deliverable is propositions + REASONING CHAINS (owner redesign, 2026-09-30): a chain is premises that JOINTLY entail a conclusion — independent arguments for the same conclusion are separate chains, conclusions are reusable by id as premises, and a bare proposition rides the propositions list alone. The wire schema carries propositions (id/name/statement/optional aliases) + chains (premises minItems 1/conclusion) — and since the chains-primary ruling (2026-09-30) the STORE carries exactly that wire shape: chains append as-is to `chains.jsonl` (`SessionFindings` IS the store shape now; `chainsToEdges` and `chainsToGraph` are deleted — no translation seam exists). **Supports edges are retired entirely** (owner, same evening): `EdgeType`, the supports draw toggle and thickness slider, and every supports code path are gone — a stored typed edge no longer exists anywhere, and every arrow on the canvas is derived from a chain. No migration, no backcompat: the pre-chains graph data was wiped by ruling. The chain laws are enforced by the practice-proven error-back hook at the submit seam: every premise/conclusion id must resolve to a submitted proposition, premises are non-empty, no self-reference — a violation returns an error string and the model re-submits within its turns. The prompt is GOAL-FIRST, no rule armor (owner philosophy ruling, 2026-09-30): one shared `EXTRACTION_CORE` (the goal, the truth law, the submission mechanics) plus two one-sentence contextualizations — session and notes preambles — assembled at the call sites, so both front doors share the core by construction; the old defensive lists (DROP lists, merge-your-own-output, name walls, when-in-doubt-omit, the faithfulness paragraph) are all cut, and the old opening describing Quiz/Recall-check/Question blocks (stale since the teacher-prose ruling) is simply omitted. A `prepareArguments` heal at the pre-validation seam rescues stringified-payload submits (propositions or chains). Every node is an objective, world-facing fact. No quiz outcomes, no understanding assessments — the events ledger and `UnderstandingLevel` are deleted; the learner's relationship to a proposition is practice territory — which landed 2026-09-29 as **feedback-only strengthening** (§7): grades live on problem sets, and nothing ever writes learner states back to the graph.

**Digest-aware serialized extraction — the extractor is the assembler** (owner redesign, 2026-09-30 evening): the spine stage came and went in one day — the owner's live test showed the post-hoc assembly pass added complexity without perceptible gain, because the real problems (restatement nodes, shallow re-derivations) are mint-time issues. The replacement moves assembly INTO the extractor: when a source already yielded material, each stretch's extractor prompt carries **THE GRAPH SO FAR** (that source's merged propositions and chains, ids verbatim), and the extractor builds on it — referencing existing ids instead of restating them, leaning on established conclusions as premises. Chains may therefore span stretches: endpoints are a mixed namespace of fresh local ids OR existing `n_` ids (validated at the submit seam, error-back; the merger's job-local map passes existing ids through verbatim). The system prompt reframes the goal as uncovering the source's **core ideas** and showing how everything **derives from the foundations** — direction upward, prefer lean derivations, never re-derive what the graph already holds. Because each stretch must read every earlier merge, a source's batches/chunks run **STRICTLY IN ORDER** (serialized per source); cross-source runs stay parallel. The first stretch of a source runs bare (no digest, no extra spend).

**Chain simplification — the merger's maintenance pass** (owner, 2026-09-30 evening): the same conclusion often arrives from many angles — `[A,B]⟹X`, `[X,C]⟹Y`, and then `[A,B,C]⟹Y`, which adds nothing. At every merge, `simplifyChains` (core/graph.ts) walks the WHOLE chain ledger and drops provably redundant chains: per conclusion group, greedy in (premise count, creation time) order, a chain is redundant when a kept chain's premises strictly contain its premise set (**prefer the fewest premises**) or when every premise is covered by a kept chain's premises plus their transitive ancestry (**ancestry-cover** — `[A,B]⟹X` + `[X,C]⟹Y` covers `[A,B,C]⟹Y`, and transitively through deeper derivations). Same-(premises, conclusion) lines are one logical chain — a key drops with every provenance line. The rewrite rides the merge's audit-locked critical section (atomic `rewriteLedgers`); run stats count the drop separately (`droppedChains`) so appends and maintenance never blur. Simplification runs at merge time because a NEW chain can make an OLD one redundant — nothing is retroactively re-derived, only provable redundancy is removed.

**Per-chunk jobs, serial per source** (owner rulings 2026-09-28 + 2026-09-30 evening): every chunk (notes file) and every batch (chat coverage) is its own JOB — registry row, usage record, failure domain — but a source's jobs run STRICTLY IN ORDER (each extractor continues the source's digest; see above). Cross-source extracts stay parallel, throttled by a process-wide 3-permit extract semaphore on `globalThis` (the provider-facing rate stance; a job waiting for a permit shows `queued`). The audit→merge section remains a process-wide FIFO critical section — a mutex on `globalThis` (the same module-instance idiom as the run registries): before any auditor LLM call or graph read, a job waits (`waiting` phase) until every earlier job's merge has landed, so each auditor explores the graph as it actually stands — two concurrent audits would each link into a graph the other is about to change, the structural mint of duplicate nodes. Failure isolation: one job failing (bad chunk, degraded model output) is absorbed — its messages stay uncovered and honestly re-runnable while its siblings still merge; the run returns what actually merged. Abort is source-wide: the serial loop stops at the first AbortError, and merged jobs keep their checkpoints. The status feed shows one row per job (`file.md · 2/5` suffixes for chunked sources), and each job persists its own usage record (failed jobs bill their partial spend too).

**Division of trust** (the pipeline's core rule): the extractor is fully trusted and is the only stage that ever sees the source. The auditor never sees the transcript — it receives the findings' PROPOSITIONS ONLY (the chains never reach the auditor: they are the extractor→store deliverable and the merger's business — owner ruling, 2026-09-30) and explores the existing graph through read-only tools (`find`, `list_sessions`, `list_propositions` — statement text included, no timestamps) to reach its verdicts. VERDICTS-ONLY (owner ruling 2026-09-28): the auditor's submit is `{ links }` — identity links only (which findings propositions ARE existing nodes). The edges argument is GONE (owner, same evening): the auditor never creates relations between propositions — cross-source connection happens solely through identified equivalences, and argument structure comes from the extractor alone. It never restates the findings; the merger joins findings + verdicts, so an order of magnitude less is emitted and there is no structural way for the auditor to alter or drop extractor output. Equivalence bias (owner ruling 2026-09-27): paraphrases, rewordings, and compressions of the same claim MERGE; only genuinely distinct propositions stay apart. The deterministic merger validates and appends: link resolution, chain resolution through the job-local map (which passes existing `n_` ids through verbatim for the digest-aware extractor's mixed-namespace chains), chain dedupe by (sorted premises, conclusion) — a known argument re-asserted by another chat appends under the SAME `arg_` id (link-style: the first line's id and createdAt stand, provenance unions) — the chain-simplification maintenance pass (below) — coverage checkpoints. No stage rejects the extractor's output; simplification only removes provable redundancy. **Per-job in-memory resolution** (owner, 2026-09-29): the mappings ledger is deleted — each job resolves its own proposition ids against the graph in memory and merges independently, so no job can see or collide with another's ids (the persisted table once silently dropped same-id propositions across chunks and welded wrong edges). Cross-job and cross-run identity is the auditor's links alone, plus the coverage ledger (nothing re-extracts) and the notes content-fingerprint guard.

**Coverage, not quiz-counting** (supersedes the v1 every-N-quiz-answers trigger): each message's *view* (the compact line format `core/coverage.ts` has always hashed) is hashed into a per-chat fingerprint ledger (`coverage.jsonl`); "covered" means exactly "a run committed on this content." The prompt view is the richer markdown document — a deliberate 2026-09-27 split: re-formatting presentation never re-opens covered history. Uncovered = fingerprint diff, never dual-tracked; runs are greedy token-budgeted batches (`graph.extractionChunkTokens` — a settings knob, default 8192 since the digest-aware redesign doubled it 2026-09-30, floor 500, read fresh each turn) of the oldest uncovered messages — quiz-less sessions extract too. A coarse `sessions.jsonl` checkpoint still marks each merged run. The trigger seam (`turn-service.ts`) is trigger-agnostic from the pipeline's side: when a better mechanism lands (session end, idle, explicit flush), only the seam changes. Single-flight per source; the run registry powers the coverage UI and true abort.

**Two front doors, one pipeline**: chat transcripts (quiz-triggered) and raw personal notes (`POST /api/graph/import` — each file becomes a `NotesSource` playing the `chatId` role, deterministic id from the path hash; a content-fingerprint stamp makes an unchanged re-import a TRUE no-op — no model calls, no usage — while changed text re-runs the whole file, owner 2026-09-29). Notes chunk like chats (owner, 2026-09-28): large files split at line boundaries under the same token budget, and each chunk runs as its own job exactly like a chat batch — serial per source (digest order), serialized audits under the gate. No single model call carries a whole file. Both submit tools require their top-level fields (`chains`/`links` present even when empty): a payload missing them fails validation rather than silently merging structure-less nodes.

**The read channel is pure derivation.** `GET /api/graph` reads the ledgers without writing. Stored truth is propositions (`nodes.jsonl`) and reasoning chains (`chains.jsonl`). `graphSnapshot` merges them, while `deriveView` (core/graph.ts) exposes a graph-shaped API projection: multi-premise chains yield implication nodes and premise→implication→conclusion links; dangling chains drop. This projection is no longer drawn as a canvas. `birthSessionPartition` (core/session-clusters.ts) groups propositions by birth source for graph tools and practice without visual layout or stored positions.

**Deletion is cascade-aware.** Deleting a proposition removes each stored chain referencing it, whether as premise or conclusion. Deleting an `arg_` argument removes exactly that stored chain, not its constituent propositions. The phone's chain-table picker still offers fenced deletion; canvas right-click deletion is gone.

**The teacher probes, nothing is injected** (supersedes the semantic-injection experiment, killed 2026-09-23): the teacher reaches the graph on its own terms through two read-only prober tools — `list_sessions` (birth sessions, the learner's files) and `list_propositions` (the names of what a session covered) — gated by the `agent.graphTools` setting (composing with `graph.enabled`). No topic embedding, no top-K selection, no session-start steer; the agent decides what to look at, and the graph never writes into a lesson unbidden.

**Presentation:** There is no graph renderer, graph layout, camera, render-settings store, or graph-position ledger in the phone UI. Teaching, notes imports, graph API reads and practice still use the underlying graph data.

---

## 7. Practice — strengthening, not assessment (owner ruling 2026-09-29)

Practice turns the graph into problem sets the learner reasons through out loud. The purpose ruling first: this is **strengthening, not assessment**. Grades are feedback for the learner — a score, a brief justification, a look at the model solution — and nothing else. Grading writes nothing to the graph, no understanding levels exist anywhere, and the vision doc's exam machinery (scores, streaks, spaced repetition over failure rates) stays parked. A set exercises what the learner already met; it certifies nothing.

**The chain model.** Practice reads the STORED chains directly (chains-primary, 2026-09-30): `chainsForSelection` (`src/core/practice.ts`) includes a stored argument iff its conclusion AND every premise are selected — an argument missing any member is excluded entirely, and a node in no surviving argument becomes a singleton chain; premise-only nodes belong to no chain. Each argument keeps its own `arg_` id: two independent arguments for one conclusion stay two chains (never a unioned premise set — the exact corruption edge-grouping invited). The partition must cover every chain **exactly once** — a true partition; duplicates fail validation exactly like gaps (owner amendment 2026-09-29: variety accumulates ACROSS sets, never within one — the at-least-once doctrine is dead). `chainCoverage` is the soundness check: only `missing` fails a partition, `duplicated` is informational.

**Self-contained sets.** A `ProblemSet` freezes its world at creation: the selected node ids, a **propositions snapshot** (`Record<nodeId, {name, statement}>`), and the derived chains all persist into the set (`data/practice/*.json`, one file per set, `PracticeStore` port). Generation, grading, coverage, and the UI read ONLY the set — later extractions can never shift the ground under a live or historical set.

**The three axes are discretized named levels** (owner, 2026-09-29 — never a number to interpolate; there is no continuum between levels): the **ladder rung** (the main axis — 0 Worked example, 1 Completion, 2 Direct exercise, 3 Composition, 4 Path-finding; the invocation names the rung and the generator builds exactly that CLASS of problem), the **cue distance** (0 Lesson context — the textbook/toy-example shape in the teaching's own framing; 1 Adjacent context — a genuinely new situation built from the teaching's own world; 2 Far context — the edge of the recognizable band, where the proposition must still genuinely apply and be findable by looking), and the **presentation** (Theory — the subject's own terms, or Application — a concrete worldly affair in which the proposition's structure appears in the wild; it dresses the situation, never changes the rung or the cue distance). The names + one-line definitions live in one place (`src/core/practice.ts`'s level tables) and are spoken by everything: the agents' prompts (`renderParams`), the creation dialog's stepped controls, the exam header's levels line. Creation defaults: rung 2 Direct exercise · cue 1 Adjacent context · Theory. The API validates the exact unions — a float between rungs is a 400; legacy float-params sets fail the store validator and are skipped (no migration — `data/practice` is disposable scratch).

**Two-stage generation.** One **partitioner** agent reads the chains plus the three NAMED-LEVEL parameters and submits the true partition; each partition becomes one problem's target. Then **one generator agent per problem**: its prompt carries the problem-engineering framework verbatim (the owner's doctrine — the three distances, the search-to-solution axis, the rung ladder, reverse/discriminate/probe-the-premises, the standing prohibitions, the formatting doctrine — full Markdown, LaTeX math, fenced code, tables/lists; prose-only renderings of structured content are a defect), **YOUR TARGET** (the assigned chains echoed verbatim — the echo law: the submit's chain set must equal the assignment exactly), and **THE FULL SET** (the whole selection: outside propositions are supporting material the generator may draw on with minimal use and maximal focus; the never-announce law covers ALL propositions). The submit is commit-before-pose — statement, solution, and rubric arrive together (the same sycophancy mitigation the quiz/explain mechanic uses); a problem never exists without its pre-written answer. Generators run in parallel (a process-wide 3-permit semaphore shared with grading) with per-problem failure isolation: one bad problem errors alone; the set still reaches `ready`. **Dedup across sets**: each generator also sees the problems of the ≤5 most recent sets sharing a node, so situations don't repeat between sets; within a set, parallel generators can't see each other — accepted for V1 (owner ruling).

**Grading is score-only (owner redesign, 2026-09-29).** ONE ATTEMPT: each problem has its own submit button; once submitted the answer persists and the problem is done — the route refuses re-submission forever after. The submit reveals INSTANTLY (no waiting on the grader): the answer locks read-only, the model solution shows, the rubric sits collapsed. Grading fires one **grader** job per answered problem — the grader sees the problem, the propositions its chains touch, the pre-written solution and rubric, and the learner's answer, never the full set (minimal, by ruling) — and returns an integer **score 0–10 plus one or two sentences of reasoning** (which rubric points were met or missed, which proposition failed to come to mind). The score lands on the problem via the page's events-channel tick (activity-changed → debounced liveness read, S7) and updates live; grades never serialize set-wide (submitting B while A grades is fine — the shared pool bounds parallelism). Nothing reaches the graph, no level, no count, anywhere. A dropped grade leaves the answer standing with an honest “grade interrupted” line — one attempt, no re-submission.

**The jobs pattern — registry, not JobRecords.** Practice runs are NOT Workbench jobs: no `JobStore` records, no steer messages, nothing ever wakes the teacher — a practice run isn't chat-scoped (a set outlives its birth session and has no lesson to re-enter; its result is itself, persisted in its own store and read by its own page). What it shares with the Workbench is the observability surface: a `globalThis` run registry (the module-instance idiom — `__lhPracticeRuns`) with PER-PROBLEM ROWS (owner ruling, 2026-09-29 — matching the extraction per-chunk pattern): `setId:partition` while the partitioner runs ("Partitioning — title"), then one `setId:gen:problemId` per problem ("queued"→"generating", label "Problem i/N — title"), and one `setId:grade:problemId` per graded answer ("queued"→"grading", "Grading i/N — title") — each row its OWN abort controller and its OWN usage accumulation; the row key IS the feed id (the dock dup-key law) and the abort target. ABORT ROUTES BY ROW SHAPE: a gen-row abort kills THAT problem only (siblings continue; the set still settles `ready` with one errored problem), a partition-row abort ends the whole run, a grade-row abort drops that grade (answer kept — one attempt, the problem stays done); set-level abort (delete) composes from row aborts plus the synchronous persisted marks. Model calls — partitioner included — run under the SHARED background-LLM semaphore (`bg-llm-semaphore.ts`): one process-wide pool of 3 permits for ALL background LLM jobs, extraction chunks included (total background LLM concurrency bounded at 3, whoever calls). A boot sweep marks orphaned `partitioning`/`generating` sets as `error "Interrupted (server restarted)"` — once per process, and only when the set's `updatedAt` heartbeat is >120s stale (a live run's 30s FILE watchdog keeps the heartbeat fresh even across dev's per-worker processes — the registry is not shared between them; the guard trio closed a live-stamping bug from the first live test) — the job runner's crash-honesty at set grain. Store writes serialize behind a per-set mutex; the pipeline is the sole writer of `data/practice`.

**API + UI.** Creation is graph-domain: `POST /api/practice/sets` takes `{nodeIds, params, title?, note?}`; the note is optional free-form learner input, trimmed and capped at 2000 characters, which agents weigh without overriding partition or difficulty rules. `GET /api/graph/clusters` serves the birth-session cluster picker; `GET /api/practice/sets`, `GET/DELETE /api/practice/sets/[id]`, and `POST /api/practice/sets/[id]/answers` manage sets and one answer per problem. The `/practice` page shares the standard TopBar and shows the list, creation dialog, and problem-set pages, where each numbered problem has a textarea and its own Submit button, with immediate solution/rubric and a live score.

Historical UI note: the graph view's Chains button previously opened a full-bleed chain-table overlay and let selected nodes create practice sets or be deleted. That visualization and its management controls have been removed in the phone-only UI; practice node pages and the graph-backed `/practice` creation flow remain. The sidebar's Practice nav row links to `/practice`.

**Model wiring.** Three roles — `partitioner`, `problemGenerator`, `grader` — all pinned to the **strong** slot (quality-critical, one settings edit from cheap) and in `BACKGROUND_MODEL_ROLES` (per-role overrides). The stage agents are single-submit loops on the shared `runSubmitAgent` seam (`submit-agent.ts`, extracted from extraction for exactly this): a `validate` hook turns a bad submit into a tool-input error the model retries against, within `maxTurns 4`; exhaustion fails the stage honestly (the set says so, the chains re-run cleanly on a new set).

---
## 8. Process boundaries (the machine room)

The browser talks to the authenticated standalone Next.js server through same-origin APIs and event streams. Docker can run the server behind a loopback-bound, tailnet-only HTTPS proxy; see [development.md](development.md#private-browser-access). There is no Electron launcher, desktop IPC, or desktop authentication mode.

The server owns teaching, extraction, jobs and graph persistence under `LH_DATA_DIR`. It calls configured model/search providers, system Chrome for demo verification, native PDF/SVG renderers, and (when opted in) the pinned Claude Code CLI as a child process. Credentials are configured out-of-band through owner-only server files or environment variables; see [pi-engine-swap.md](pi-engine-swap.md).

Settings → Providers exposes read-only server connection status. The model selector and `/api/models` catalog remain; API-key editing, browser provider sign-in, the custom-endpoint editor (`/api/custom-provider`), setup dialogs, auto-updates and theme controls do not. Reading typography settings and read-time pricing/cost calculations remain.


## 9. The foundational invariants — what ALWAYS holds

### Tier A — machine-enforced (`eslint.config.mjs`; lint fails the build)

| Law | Zone |
|---|---|
| **Imports point inward.** `src/core` never imports `agent`/`server`/`store` | zone 3 |
| **The shell sees barrels only.** `components/**` → `@/src/core`; `app/**` → `@/src/core` + `@/src/server` | zones 1–2 |
| **The agent layer never imports server or store** — every dependency arrives as a factory/closure argument | zone 4 |

### Tier B — gate-enforced elsewhere

| Law | Gate |
|---|---|
| Strict types, no silent indexing (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) | `tsc --noEmit` |
| No session data in the bundle; prompt assets traced | `build-server.mjs` hard-fails |
| The core barrel stays browser-safe (node-bound/heavy modules deliberately excluded) | barrel doc-comment; chunk-verified when the exclusions were set |

### Tier C — conventional, verified to hold in the code today

| Law |
|---|
| **One composition root per concern** — `stores.ts` (storage), `chat-handler.ts` (a turn) |
| **One writer per ledger** — the merger is the sole graph writer; chat records written only by the turn pipeline; job records only by the runner; positions PUT is the only sanctioned graph-adjacent exception |
| **The store never decides** — adapters persist and shape-guard; merge/dedup/derivation semantics are reader-side, in core |
| **Derived, never dual-tracked** — append-only evidence; every state recomputed at read (snapshot, plan statuses, phases, costs, coverage) |
| **Idempotency via deterministic keys** — steer ids, ledger refs, coverage fingerprints, source content fingerprints, cluster content hashes; re-running anything converges |
| **LLMs judge; code mechanizes** — grading, merging, fingerprints, layout are deterministic; a failed LLM stage checkpoints nothing |
| **The persisted record is the only source of truth** — agents are stateless per-turn rebuilds; no unanswered tool call reaches a provider |
| **Failure containment** — side channels (context, extraction, usage, naming) are fire-and-forget behind try/catch seams; a side-channel failure never touches the response or the persist; the turn registry clears on every path |
| **Absence is not zero** — unreported tokens, absent prices, absent levels render as absent, never fabricated |
| **Schema-valid ⇔ parseable** — boundary zod schemas are shared verbatim by producer and consumer |

### Known deviations from the ideal (documented, deliberate or accepted)

- Two portless settings adapters re-exported through the server barrel; `observability.ts` imports `chatStore` directly. The "only `stores.ts` imports adapters" rule is documentation-only.
- Scripts act as extra composition roots (and backfills are extra graph writers); tests import freely across layers.

---

## 10. Observability and change delivery (the push model, owner ruling 2026-10-02)

Structured-logging frameworks are still deferred; the baseline is one correlation-tagged log line per event at the seams (`[chat <id>]` on turn services, `[extraction <id>]` on the pipeline, `[job <id>]` on runners, `[graph]` on reads). What has grown past log lines is the **activity feed** (`server/observability.ts` → `GET /api/activity` → the activity dock): running jobs, extraction runs, and practice runs (per-set rows: generation/grading phases), per-run usage (money channel), and true abort (`POST /api/activity/abort` — kind `job`/`extraction`/`practice`). When structured logging lands, it goes behind these seams — no call sites change.

### 10.1 The events channel — how the client learns truth moved

Before 2026-10-02 the client discovered server-side change by polling: a lattice of interval polls (sidebar 2.5s, dock adaptive 2.5/10s, jobs 1/4s, graph status 2s, practice 2s, post-turn watches) whose blind spots were measured in the probe→teach handoff freeze (a server-initiated turn in a jobless session was invisible to an open view). The ruling: **push** — exactly one app-scoped SSE channel, `GET /api/events` (`core/events.ts` bus → `server/events-stream.ts` seam), held open by **one EventSource per open window** (`components/server-events.tsx`, mounted outermost in the root layout — the only file where `EventSource` exists). The client owns the connection's lifetime; the server frames `: ping` heartbeats every 25s and never closes first. **Notify→fetch**: payloads never carry data — an event says only *that* truth moved (plus a key like `chatId`); every consumer then fetches fresh from the normal endpoints. Reconnects (EventSource auto-retry) fire a **resync** hook per consumer for one immediate refetch, healing any events the gap ate.

### 10.2 Event vocabulary

| Event | Payload | Emitted at |
|---|---|---|
| `turn-started` | `{chatId}` | `beginTurn` success (after the registry write; the double-begin 409 path is silent) — every turn, client-initiated included |
| `turn-settled` | `{chatId}` | `endTurn` on a live entry — fires after `persistTurn`, so fetches read durable truth |
| `jobs-changed` | `{chatId}` | every job-store write (create/update/delete-that-removed) |
| `activity-changed` | `{}` | extraction `setPhase`/`finishExtraction`; practice `registerRow`/phase-writes/`finishPractice` |
| `chats-changed` | `{}` | list-shape writes only: chat create/rename/delete-that-removed |

### 10.3 Emitter laws

- **Notify-after-write** — the emit always follows the successful write, so a fetch triggered by the event reads committed truth.
- **Present-entry gating** — mutations that changed nothing (missing-id update, delete of an absent row) emit nothing.
- **THE SILENCE LAW** — content writers (`saveMessages`, `appendTurnUsage`, `appendExtractionUsage`, `saveSettings`, `saveTree`) are deliberately silent: `saveMessages` would spam per turn-persist, and list-visible effects already arrive via `turn-started`/`turn-settled` (pinned in tests).
- **Reads never emit** — pure reads are side-effect-free (pinned).

The bus itself is a `globalThis`-backed listener set (the Next per-entry-module discipline, same as the turn registry), snapshot-iterated so unsubscribing mid-emit is safe, with per-listener error isolation.

### 10.4 Consumer laws

- **Refs, not closures** — handlers read `localStreamRef`/`turnInFlightRef`/`statusRef`, never stale render state.
- **The 409-race guard** — on `turn-started`, ignore when `localStreamRef.current` is held (the client's own turn just began; it owns that stream) or already attached; otherwise attach to the running turn (`GET /stream` live response).
- **No mid-attached-stream sync** — while attached, the terminal frame owns settle; a `turn-settled`-triggered `syncFromServer` would swap a stale snapshot and break in-place continuation (the one exception: error status heals by detaching).
- **~250ms trailing debounce** — bursty emitters coalesce into one fetch per window (sidebar/dock/jobs/graph/practice all share the shape).
- **Resync on reconnect** — every consumer refetches once when the channel (re)opens.

### 10.5 What remains bounded or local, and why

- **Extraction-coverage ×2** (session menu block + ring) — bounded, run-scoped 2s reads: the ring drains **per fold**, and the events channel is per **phase**; that granularity gap is accepted by design (owner, 2026-10-02).
- **The 409-retry poll** (`session-core.ts`, 500ms→5s ramp) — a racing client's bounded backoff while a turn it tried to start is already running; not standing.
- **Dock clock ticker** (1s `setNow`) — local rendering, no network.
- **Mount fast-paths kept** — `initiallyInFlight` (attach on render-time snapshot), the mount-time `needsContinuation` check, and the `lh:chat-renamed`/`lh:turn-state` **local window broadcasts** (instant same-tab patching; the channel is for cross-window and server-initiated truth).

---

## 11. Testing

All deterministic, no network: engines are injected (pi-ai's **faux provider** — `createFauxCore`/`setResponses` — wrapped as the `PiEngine` production uses), `globalThis.fetch` is stubbed where transport matters, and pure logic gets in-memory port implementations. Suites either mirror production wiring with the real fs adapters (backup-and-clear of the ledgers they touch) or swap in-memory ports deliberately ("this suite never touches data/graph"). Four strata:

1. **Pure core units** — merger via real adapters, derivation, coverage, question grading, plan tree, phases, clusters, tool-parts, prices, fuzzy search.
2. **Server flows** — `handleChatRequest` driven end-to-end with scripted faux engines: persistence, liveness, steer claiming, the wake pipeline (409 retry, quiz deferral, idempotency), crash recovery, the data-dir seam (including a fresh child process).
3. **Sub-agent loops** — researcher/demo-builder/visual-maker with fake headless APIs; the extraction pipeline end-to-end (audit drops, failure-checkpoints-nothing, single-flight, abort); the practice pipeline end-to-end (partition echo/coverage retries, failure isolation, semaphore width, abort mid-generation, grading, boot sweep).
4. **Render tests** — transcript, cards, composer, overlay sidebar, coverage, stats and practice surfaces (cluster creation, list, problem-set and node pages) via React server-side rendering (`renderToStaticMarkup`), no DOM library.

Gates on every change: `tsc` clean, all tests, `eslint` clean, `next build` clean.

---

## 12. The seam directory

Every place the architecture is designed to be cut — the "one file" a future change should touch:

| Seam | File | What it swaps |
|---|---|---|
| Storage decision (JSON→SQLite, remote) | `src/server/stores.ts` | the adapters, once |
| LLM engine / model per role | settings `models` slots + `src/agent/models.ts` (`piEngineFor`) | provider wiring, one place |
| Turn composition | `src/server/chat-handler.ts` | what a turn consists of |
| Extraction trigger | `src/server/turn-service.ts` (`triggerExtraction`) | when the Library runs |
| Practice orchestration | `src/agent/subagents/practice-pipeline.ts` | generation/grading flow without touching contracts |
| Graph access for teacher | `src/agent/tools/graph.ts` (`list_sessions` / `list_propositions`) | what the teacher can probe, one gate |
| Steer delivery (wake) | `src/server/jobs.ts` + injected `deliver` | how background results re-enter lessons |
| Push events | `src/core/events.ts` (bus) + `src/server/events-stream.ts` (SSE seam) + `components/server-events.tsx` (the window's EventSource) | change notification, end to end |
| Agent construction (tests) | `handleChatRequest(req, buildAgent?)` | scripted engines, no refactor |
| Sub-agent verification | `sub-agents/headless.ts` (`headlessOverride`) | demo/SVG verification, no Chrome |
| Data location | `LH_DATA_DIR` env (`config.ts` PATHS) | where data/ lives, nothing else |

---

## 13. Decision history — superseded decisions (do not re-litigate without new evidence)

Each of these was implemented, lived in real data, and was replaced; the replacement reasoning is in `docs/vision.md`'s amendments table.

| Superseded | Replaced by | When |
|---|---|---|
| Live-emission graph construction (per-session, plan-tree-derived) | Post-hoc, tree-blind extraction pipeline | 2026-09-02 (vision §1) |
| `taught` events, misconception nodes, node descriptions/kinds | True propositions only; wrongness lives in the ledger; name+statement+aliases | 2026-09-02/08 |
| Editable plan tree (`plan_add_node`…`plan_mark_done`) | Author-once `plan_init` + derived statuses | 2026-09-08 era |
| Hotspot + 1-hop graph context | Semantic top-K under token budget, delivered as a steer | 2026-09-14 (vision-context-injection) |
| every-N-quiz-answers extraction trigger | Token-coverage batches (fingerprint ledger) | 2026-09-15 (vision-extraction-coverage) |
| sigma.js + graphology + forceAtlas2 + Louvain clustering | Hand-rolled Canvas 2D renderer, d3-force layout, embedding-based agglomerative clusters | 2026-09-13 era |
| Hand-rolled Canvas 2D + d3-force layout, stored render settings/positions | No graph visualization or graph-layout persistence; graph ledgers, APIs and practice data remain | 2026-10-26 private-fork phone UI |
| Vercel AI SDK LLM loop (`MockLanguageModelV4` tests) | pi-ai engine (faux-provider tests), AI SDK kept as the UIMessage protocol | pi-engine-swap |

## 14. Deliberately deferred

Structured logging (§10); SQLite/remote storage (drop-in behind the ports, §3); multi-scale cluster hierarchy (Louvain's dendrogram idea, parked); the anchored calibration rubric; alternative extraction triggers beyond the coverage seam (session end, idle); retroactive bootstrap of the POC sessions (vision §1 consolidation). Historical decisions above remain useful for their data and server rationale; check the development guide for the current fork UI before following presentation-specific passages.