# First Release (0.3.0) — polish list + lock question

> **Historical planning notes (2026-10-06), not the current release checklist.**
> Desktop packaging, signing and automatic updates described below are historical upstream work, not this browser-only fork's release procedure. See [development.md](development.md) for the server workflow.

> **Private-fork UI supersession (2026-10-26):** Items 1–2 and 6–8 below
> record historical proposals, not work to implement: the graph visualization
> and rendering toggle, keyboard shortcuts/keybindings, and desktop layout were
> removed. The phone UI is used at every width; questions are inline in the
> transcript, Settings uses sheets, and the sidebar is an overlay. The home page
> has a topic composer. Knowledge graph storage, extraction, APIs and practice
> node pages remain. Electron packaging has been removed.

Started 2026-10-06, owner brain-dump round. Priority 1 — everything else (assessment levels → docs/vision-assessment.md) comes after. Items are captured as spoken; design decisions inside them are **unruled** unless marked.

## Polish items (owner list, 2026-10-06)

1. **Graph rendering toggle — separate from the extraction pipeline.**
   Today's graph on/off switch toggles extraction. Wanted: two switches —
   one for the *pipeline* (named for what it does), one for *rendering*
   ("graph on/off" = the graph view renders or not). Data, chains model,
   extraction all keep working with rendering off.
   - Open: **what is the home view when graph rendering is off?** It must
     keep the import-notes button, the chains-view button, and the graph
     pipeline cost readout. Candidate raised and not rejected: the chains
     view (the chain table is already a complete non-graph presentation of
     propositions + chains). A "giant DAG" was raised and rejected. Unruled.
2. **Keyboard navigation for questions** — arrow buttons (next/previous
   question) are currently click-only; make them real keybinds, with VIM
   bindings (j/k or similar) as the goal. Maybe rebindable, maybe not — unruled.
3. **Session naming.** First-message-as-name is not clean (the first message
   is always long). Owner dislikes LLM-generated names. A naming popup after
   first send was considered — possibly annoying; unruled. (Fact: the top-bar
   title is already click-to-rename; whatever lands should agree with it.)
4. **Export sessions as markdown** — now available from the sidebar context
   menu by desktop right-click or touch/pen long-press. The export uses the
   session-markdown serialization already used for extraction.
5. **Export the reasoning chains / graph** — format unruled (JSON is the
   obvious candidate: serve the graph snapshot). Placement unruled.
6. **Graph default settings refinement** — current defaults not ideal; minor.
7. **Compaction summary dialog** — covers the entire screen and doesn't look
   good; Esc prompts a dismiss question instead of just closing. Law stated:
   **Esc always acts on the current element on screen.**
8. **General keyboard audit** — everything must work from the keyboard; some
   minor things don't. Examples to be enumerated in the round.

## What does "released" change in development? (the lock question)

Position agreed 2026-10-06: releasing means **on-disk user data acquires
compatibility obligations** — after 0.3.0, persistent-schema changes are
migrations with tolerant reads, not free edits plus wipe-your-dev-data.
Nothing is frozen forever; the discipline changes.

Persistent surfaces (the obligation set):
- `data/chats/*.json` — ChatRecord: messages (pi-ai wire shapes: thinking
  blocks, toolCalls, usage), turns, kind, graphContext. The deepest lock —
  and coupled to the pi-ai library's serialization (a pi-ai bump becomes a
  migration event post-release).
- `data/graph/` — nodes.jsonl, chains.jsonl, coverage.jsonl, sources.json,
  sessions.jsonl (append-only ledgers). The retired visualization's
  `positions.json` and `render-settings.json` are not current obligations.
- `data/settings.json` (models, extraction, compaction…), `auth.json` (BYOK keys).
- Client localStorage still in use by the phone UI; retired graph camera,
  zoom, filters and kind controls are not persistent obligations.
- `data/jobs/` — treat as scratch/transient, no obligation.

Known gaps to close *before* release (proposals, unruled):
- **No schemaVersion anywhere.** Cheap now, load-bearing later: stamp
  ChatRecord, settings, and the ledgers with a version at write time;
  readers default missing → current. This is what makes later migrations
  painless.
- **Pin pi-ai/pi-agent-core exact versions** so record shapes move only
  deliberately.
- Release engineering outside code: signing/notarization await Apple
  Developer enrollment (DMG is unsigned today); no auto-updater (manual
  download acceptable for 0.3.0 if stated); packaged-app data location
  already correct (LH_DATA_DIR → userData).
