# The pi engine swap — design record

Date: 2026-09-12. Status: PLANNED (facts verified, awaiting go).

Decision (user, 2026-09-12): swap the server agent engine (Band B) and the
UI-stream bridge (Band C) from the Vercel AI SDK to **@earendil-works/pi-ai**
(provider/catalog/streaming layer) + **@earendil-works/pi-agent-core**
(agent loop). The client (Band D: `useChat`, transport, UI kit) **stays** on
the AI SDK. The transcript contract (Band A: UIMessage-shaped records,
`TeacherUIMessage`) **stays** as-is. Model/thinking controls come after the
swap, and the architecture below is shaped so they fall out of pi's catalog
naturally.

Motivation: SDK ambiguity has cost us repeatedly (data-part conventions,
UIMessage merge rules, retry paths, continuation coalescing — all took
forensics to understand). pi's layers are minimal and the user knows them
deeply. After this swap every piece of the turn pipeline is either ours or
pi's, each fully understood.

Verified package facts (all three scouts + npm registry):
- `@earendil-works/pi-ai` + `pi-agent-core` latest **0.85.1**, MIT, ESM-only,
  Node `>=22.19.0`; the browser-only server runs on Node.
  Plain registry installs, no vendoring. The old prototype
  (/Volumes/T7/code/learning-system) ran 0.84.2 cleanly with the same wiring.
- pi-ai = providers/catalog/streaming only: `createModels()`,
  `models.streamSimple`, `calculateCost`, `getSupportedThinkingLevels`,
  `validateToolArguments`. **No agent loop, no zod, no React, no SSE.**
- pi-agent-core = the loop: `Agent` (steer/followUp/abort/subscribe),
  `agentLoop`, `AgentTool` (execute + `terminate`), JSON-Schema validation
  that accepts plain JSON Schema (zod `z.toJSONSchema` output works, with
  coercion — verified in `validation.js:285`).

## Server-side Claude and custom endpoints

These additions use the installed pi-ai **1.4.0** provider contracts, not
the historical SDK version described above. They are server-side configuration;
the existing model picker, strong/cheap/vision slots and per-role overrides
remain the model-selection surface. No provider is selected automatically.

### Claude Code

The `claude-code` provider drives the real `claude -p` CLI with LearnHarness
tools exposed over MCP. It avoids presenting SDK OAuth traffic as Claude Code,
which is not permitted for third-party tools under Anthropic's subscription
policy.

On the server the provider stays off until `settings.json` contains
`"claudeCode": {"enabled": true}` (there is no Settings toggle in this fork).
The runtime image installs a pinned `@anthropic-ai/claude-code`; the CLI owns
authentication. Create a long-lived token on a trusted workstation with
`claude setup-token` and supply it as `CLAUDE_CODE_OAUTH_TOKEN` in the
server's private environment. `CLAUDE_CONFIG_DIR` must be a writable directory
for the CLI's own state. Usage shows as "CLI", unpriced.

An explicitly configured `ANTHROPIC_API_KEY` still enables the ordinary
Anthropic API provider. No API keys, tokens, or header values are returned in
the model catalog.

### Custom OpenAI-compatible endpoints

Set `LH_CUSTOM_PROVIDERS` to a JSON array in the server environment (or
`.env.local` for local development). Restart after changing provider definitions.
Secrets can be inline strings, but environment references are recommended:
they resolve server-side for every request, never by executing shell commands.
For example, after supplying the referenced variables privately:

```sh
export LH_CUSTOM_PROVIDERS='[{
  "id": "example",
  "name": "Example provider",
  "baseUrl": "https://api.example.com/v1",
  "apiKey": {"env": "EXAMPLE_API_KEY"},
  "headers": {
    "X-Example-Client-Id": {"env": "EXAMPLE_CLIENT_ID"},
    "X-Example-Client-Secret": {"env": "EXAMPLE_CLIENT_SECRET"}
  },
  "models": [{
    "id": "your-current-model-id",
    "name": "Example model",
    "contextWindow": 32768,
    "maxTokens": 4096,
    "input": ["text"],
    "reasoning": false
  }]
}]'
```

Replace the host, model id and token limits with values provided by the endpoint
owner. The numbers above are example configuration, not discovered limits.
There is no automatic `/models` request and no pinned custom provider model id.
Only declare image input or reasoning when the server/model actually supports
it. Model costs are unpriced (represented as zero), not verified free.

Each provider needs a unique non-builtin id; model ids must be unique within it.
`baseUrl` must be HTTPS, or HTTP on localhost/loopback for a local server; URL
credentials/query/fragment are rejected. `models` must contain explicit
`id`, positive integer `contextWindow` and `maxTokens`. Optional `input` defaults
to `["text"]`, `reasoning` to false, and `name` to the id. Unknown configuration
fields are rejected rather than silently ignored.

Arbitrary HTTP authentication headers are supported, including `Authorization`
instead of `apiKey`; all referenced environment variables must be present before
the provider appears in the picker. Header-only and keyless local servers do not
receive an invented bearer token. Configured API keys use normal bearer auth.
Custom models use `/chat/completions`, not the Responses API. The optional model
`compat` object exposes `supportsStore`, `supportsDeveloperRole`,
`supportsReasoningEffort`, `supportsUsageInStreaming` and `maxTokensField`
(`max_tokens` or `max_completion_tokens`). Conservative defaults disable store,
developer-role and reasoning-effort fields and use `max_tokens`.

All calls to the same custom provider are serialized for the full stream,
including foreground and background calls. Separate providers remain independent.
Cancellation while queued produces an aborted response without dispatch. This
is a process-local limit, not a fleet-wide quota: do not run multiple server
processes against a light-use endpoint and expect global serialization. Only assign
background roles when the endpoint owner has approved their load.

## 1. Engine architecture — stateless per-turn Agent, record is the truth

**The record stays the source of truth.** Every turn constructs a *fresh*
`Agent` from the persisted UIMessage record via our `convertToLlm` adapter,
runs it, persists the resulting parts back into the record, discards the
Agent. pi's `steer()`/`followUp()` queues are **in-memory** (plain arrays on
the instance) and die with the process — they are for a *held-live* agent
(pi-coding-agent holds one Agent per session lifetime). lh's architecture is
the opposite: HTTP request-scoped turns, durable wake pipeline, write-ahead
persistence, 409 one-turn guard. Those stay exactly as they are.

Concretely, per POST to `/api/chat`:
1. `beginTurn` / 409 guard / write-ahead persist (unchanged, `chat-handler.ts`).
2. `claimSteers` coalescing (unchanged — server wake messages are appended
   into the record *before* the turn, which is what already happens).
3. Build `initialState.messages` = `recordToPiMessages(record)` (§4).
4. `new Agent({ initialState, streamFn, convertToLlm, getApiKey, tools })`.
5. Run to completion (loop runs because question tools terminate early,
   see §2; otherwise stopReason `stop`/`length` ends it).
6. Bridge (§3) emits SSE chunks while it runs; events collected for usage.
7. `onFinish` equivalent: `persistTurn` (plan-block splice, unchanged),
   `appendTurnUsage`, `triggerExtraction`, `endTurn` (all unchanged).

What we deliberately do **not** adopt:
- Held-live Agents across requests (loses durability guarantees, changes the
  409/one-writer model).
- pi's in-loop steering injection (mid-turn steers) — today a wake waits for
  the running turn to end (claimSteers at request boundary). In-loop
  injection via `getSteeringMessages` is a possible future enhancement, noted
  in §8; not in this swap.
- pi's JSONL session machinery (`harness/session/jsonl`) — our record store
  already plays that role.

## 2. The quiz/ask pattern — the heart of the swap

Three shapes were found across pi itself and the prototype; lh needs a third
variant because its question tools are **client-answered** and turn-scoped:

- pi's own `ask_question` (interactive-subagents ext): execute writes a
  sidecar file and returns; the *session layer* orchestrates the reply as a
  future message. Fits a held-live subagent, not our turn model.
- The prototype's plan: **blocking execute** awaiting the learner, graded
  verdict as the result. Fits a TUI, not HTTP — would hold a POST open for
  the minutes a learner takes to answer.

**lh's variant (the design):** question tools (`quiz`, `ask_user_question`)
are `AgentTool`s whose `execute()` returns *immediately* with a synthetic
result:

```ts
execute: async () => ({
  content: [{ type: "text",
    text: "Question posed to the learner. Turn ends here; the answer arrives as this call's result next turn." }],
})
```

- **The stop mechanism is the `shouldStopAfterTurn` hook, not
  `terminate`.** (Verified in `agent-loop.js`: terminate lives on the
  *result*, fires only after the batch executes, and only when *every*
  result in the batch sets it — so a quiz+research batch would NOT stop,
  the model would keep teaching past the quiz. `terminate` is also shaped
  for workflow-final tools, not pause-pending-input; we don't repurpose
  it.) Our wrapper's hook: *did this turn's completed assistant message
  contain a question-tool call? → return true → the loop stops before any
  further model call.* Deterministic for every batch shape; server tools
  called in the same batch (research etc.) still execute and stream their
  results first, matching today's SDK behavior where a client tool call
  ends the turn.
- The synthetic result exists only because pi's loop requires a result for
  every executed call to settle into a clean terminal state **within that
  turn**. It is *never persisted* — our record keeps the tool part with
  **no output** until the client answers, exactly as today. The dead run's
  in-memory context (placeholder included) is discarded; the learner's
  answer attaches to the *record*, and the next turn's fresh Agent sees
  the answered call as a normal tool result via the adapter (§4).
- The learner's answer (dock → `addToolOutput` → next POST carrying the
  mutated transcript) re-enters via `recordToPiMessages`: the answered tool
  part becomes a `ToolResultMessage` with the original `toolCallId`, so the
  model sees the answer as the tool result. This is precisely what pi's
  `continue()` documents ("last message must be a user or tool-result
  message") — we just feed it through our own record instead of a held Agent.
- **Authoring validation stays zod, stays ours.** `z.toJSONSchema` output
  becomes the tool's `parameters` (pi validates structurally + coerces), but
  our `superRefine` cross-field rules (correctAnswer∈options — the
  twice-fixed wording) don't survive JSON Schema. So the wrapper runs the
  zod schema itself at call time, before execution: on failure it pushes the
  error back the same way pi's own validation does — an error
  `ToolResultMessage` the model sees and retries against (verified: that's
  pi's native self-healing path, `prepareToolCall` catch →
  `createErrorToolResult`). Identical semantics to today's
  `InvalidToolInputError`.
- **Dangling question calls** (turn aborted mid-run leaving an unanswered
  quiz, or an aborted LLM call — pi salvages the partial assistant message
  with stopReason `aborted`): `recordToPiMessages` must synthesize a
  `ToolResultMessage` ("The question was interrupted") for any toolCall
  lacking a result *before* the LLM call, or providers reject the request.
  This is a hard invariant of the adapter, covered by tests.

## 3. The bridge — pi AgentEvents → UIMessageChunk SSE

We own a ~200-line `src/server/ui-stream-bridge.ts` replacing
`createAgentUIStreamResponse`. Wire format (verified from SDK source):

- Response: `text/event-stream`, chunks as flat JSON
  `data: {"type":"text-delta","id":"…","delta":"…"}\n\n`, terminated with
  `data: [DONE]\n\n`. Vercel headers not required (client ignores them);
  we send `content-type` + `cache-control: no-cache` anyway.
- Every chunk zod-validated client-side (looseObjects); malformed required
  fields put the chat in error status. Our chunk construction is typed and
  unit-tested against `uiMessageChunkSchema` shapes.

Event mapping (pi event → chunk(s)):
- `agent_start`/`turn_start` → `start` (see id rule) + `start-step`.
- `message_update` carrying pi text events: `text_start/delta/end` →
  `text-start`/`text-delta`/`text-end` (stable id per block, e.g.
  `${messageId}-t${n}`).
- thinking events → `reasoning-start`/`reasoning-delta`/`reasoning-end`.
- `toolcall_start/delta/end` → `tool-input-start`/`tool-input-delta`
  (optional; safe to skip deltas and emit only `tool-input-available` on
  end — verified clean path)/`tool-input-available` (part state
  `input-available`, static name `tool-${toolName}`).
- `tool_execution_start/end` (server-executed tools only: research, demo,
  visual, plan_init, probe_done) → `tool-output-available` with the
  serialized result. **Never** emit outputs for question tools (client-owned;
  emitting for an unknown callId throws client-side → error status).
- `tool_execution_end` carrying validation-error results → same
  `tool-output-available` (error content), matching today's behavior.
- `message_end` → collect usage (§5); `turn_end` → `finish-step`.
- `agent_end` → `finish {finishReason}` — send it always (feeds `onFinish`
  fidelity); `stop`/`length` map naturally.
- Errors mid-run: emit `error {errorText}` (does not end the stream; the
  client throws it into error status), then close. Unmask
  validation/unknown-tool messages like today.
- **Continuation id rule (the load-bearing one, from client source
  `makeRequest`/`createStreamingUIMessageState`):** if the transcript's last
  message is an *assistant* message, the client's streaming state starts as
  a clone of it and the stream must continue that message — so `start`
  carries `messageId` = last assistant message's id. Otherwise (fresh turn)
  a fresh server-generated id. Violating this duplicates every part of the
  prior assistant message (question card twice, duplicated toolCallIds).
- **Abort:** the client's Stop button aborts the fetch → Node `request.signal`
  fires. The bridge subscribes: `agent.abort()`, salvage path persists the
  partial (pi keeps the partial with stopReason `aborted`), same
  isAborted persistence as today. Job/extraction aborts (`abortJob`,
  `abortExtraction`) call `agent.abort()` on their registered runs — the
  signal threads into `streamFn` and every `execute()`, verified.

## 4. The record adapter — `recordToPiMessages` / message shapes

`convertToLlm` (ours) converts record UIMessages → pi `Message[]`:
- user text message → `UserMessage {role:"user", content, timestamp}`.
  Data parts (`data-plan-accepted`, `data-plan-block`) are dropped
  (UI-only), exactly as `convertToModelMessages` does today.
- assistant message → `AssistantMessage {role:"assistant", content:[…]}` —
  text parts → text blocks; reasoning parts → thinking blocks (+
  `thinkingSignature` persisted in the record for Anthropic resume);
  tool parts → `ToolCall {id, name, arguments, thoughtSignature?}`.
- answered tool part → after its assistant message, a
  `ToolResultMessage {role:"toolResult", toolCallId, toolName, content,
  isError?, timestamp}` built from the part's output. Question-tool outputs
  become plain text content (the graded-verdict payload, as the model sees
  it today).
- Unanswered question toolCall → synthesized interrupted-result (§2).
- `data-plan-accepted` on a user message → text "The plan is accepted —
  begin teaching." rides the message (today: `data-plan-accepted` part +
  the text part; the model only ever saw the text — identical).
- Prober/teacher seam unchanged: the teacher branch still keys on the
  `tool-probe_done` part in the transcript; both agents are constructed per
  turn from the same record.

The record format itself does **not** change this wave (Band A untouched);
thinkingSignature support is added to the part schema as one new optional
field (used only when a provider returns signed thinking).

## 5. Usage, cost, and the model catalog

- Usage: subscribe to `message_end`/`turn_end` events →
  `AssistantMessage.usage {input, output, cacheRead, cacheWrite, reasoning?,
  totalTokens, cost}` → mapped into our `CallUsage`/`TurnUsage` contracts
  (field renames only: `reasoningTokens` → `reasoning` etc.). The stats bar
  and activity dock are untouched.
- Cost: pi's `Usage.cost` comes pre-computed via `calculateCost` (tiered).
  **This wave keeps `core/prices.ts`** (tested folds, synced OpenRouter
  table) — no behavior change. Replacing prices.ts with pi's catalog cost
  is a noted cleanup for the model-control wave, where the catalog becomes
  load-bearing anyway.
- Catalog: `createModels()` + `openrouterProvider()`; our working set
  (`z-ai/glm-5.3-flash`) is **registered programmatically** (id, provider,
  api, cost/contextWindow/thinkingLevelMap from our data) because it's not
  in pi's static catalog (verified; it is in the pi.dev overlay, but we
  don't take a runtime pi.dev dependency). `getApiKey: provider → key` from
  env (`OPENROUTER_API_KEY`) now; the wave after swaps the source to
  `data/auth.json` without touching this seam.

## 6. Sub-agents

All five sub-agents (research runner, demo-builder, visual-maker, extractor,
auditor) port from hand-rolled `generateText`/ToolLoopAgent loops to
`new Agent` or `agentLoop` with the same tools+streamFn wiring. Abort
signals thread through (`execute`'s 3rd arg), usage folds from the same
events, `calculateCost` available for per-stage cost. Mechanical; largest
surface is the extractor's staged loop.

## 7. Test harness

`MockLanguageModelV4` (23 sites) is replaced by scripted pi-side fakes:
- Engine-level: a fake `streamFn` yielding scripted
  `AssistantMessageEvent` sequences (text, tool calls, terminal) — the
  async-iterator shape is simpler than the SDK's.
- Bridge-level: golden-chunk tests asserting our SSE output against the
  verified chunk shapes (continuation id rule, terminate paths, dangling
  synthesis, abort salvage).
- Adapter-level: `recordToPiMessages` round-trips (answers, data parts,
  aborted quizzes, plan-accepted).

## 8. Waves, gates, and deferred items

One atomic wave (the engine can't ship half-swapped): deps + Next
`serverExternalPackages` for pi-ai/pi-agent-core → adapters (§4) → tools
port (§2, zod kept) → bridge (§3) → chat-handler rewiring → sub-agents (§6)
→ test port (§7) → gates (tsc, full suite, lint, build) → **data wiped at
the pivot** (doctrine; record format is unchanged, so the wipe is doctrine
not necessity) → live GLM smoke: full probe→assessment→handoff→plan→
verdict→teach flow plus abort paths (question mid-stream abort, job abort,
extraction abort), zero console errors, usage correct in the stats bar.

Deferred (explicitly): in-loop steering injection (mid-turn wakes);
prices.ts → pi catalog cost migration; client-band (Band D) ownership
decisions; multi-provider auth beyond OpenRouter (the `getApiKey`/catalog
seams above are the whole preparation); pi.dev overlay refresh.

## 9. Open flags carried into implementation

- Chunk `id`s for text/reasoning blocks must be unique per message and
  stable across continuation turns (the client throws on a delta for an
  inactive id).
- `tool-input-available` requires `input` as a JSON value; pi gives parsed
  arguments on toolcall end.
- Step bookkeeping: pi `turn` ≈ SDK `step`; our per-step boundaries must
  keep `step-start` parts where the plan-block splice and phase timelines
  expect them (splice keys on tool-plan_init parts — unaffected).
- Next must not bundle pi-ai's provider deps (AWS/Google SDKs) into the
  route bundles — `serverExternalPackages`.
- pi-agent-core is single-run per Agent (`prompt()` throws if active):
  fresh-Agent-per-turn sidesteps it entirely (and matches our one-writer
  turn guard).