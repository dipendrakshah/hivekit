# 03 — Models + master/worker runtime

## Status (2026-08-27, branch `stream/3-models-agents`)

`packages/models` COMPLETE and tested (17 tests):

- types.ts attribution-required CompletionRequest (unattributed call is a compile error)
- gateway.ts single door: probe→render→adapter→spend; retryable fallback trips on
  429/5xx/timeout; PROBE OUTAGES degrade to a conservative rendering (text shim +
  prepended system) instead of killing jobs — probes are infra, not product
- render.ts capability lowering (system-role prepend is re-applied AFTER tool-shim,
  fixing a system-leak-to-no-system-models bug found by the wire-level G9 test)
- probe.ts six-lens capability vector, TTL-cached; json.ts tolerant parser with
  sibling-level concatenated-object detection (topLevelSiblings runs BEFORE the
  balance scan — sequencing bug found by corpus test) + 40-item damaged-output corpus
- ladder.ts FR-A6 three-strike validation ladder (exact error appended verbatim →
  tightened input/temperature → model-only fallback); attempts recorded so the
  appended-vs-silent success gap is measured data (DoD)
- anthropic/openai adapters over plain fetch SSE with usage-estimation flags

Still open (gateway wiring, needs apps/gateway integration): master Plan schema +
task enqueue, worker pool against JobRunner, routine preflight hooks. Tool side of
the worker contract already exists in @hivekit/tools (stream 04).

Goal: the master plans and spawns parallel workers on configurable models; spend is metered; models hot-swap.

## Work

- [ ] Model adapters: `openai_compat` (OpenRouter default, custom base URLs) + `anthropic`; plain `fetch`, no vendor SDKs; streaming into thread events.
- [ ] Call metadata `{thread_id, job_id, task_id}` required on every completion — an unattributed call must be a compile error, not a convention.
- [ ] Capability probe (6 cheap calls, cached): system role, native tools, JSON schema, long-input recall, instruction discipline.
- [ ] Capability-aware rendering: native tools where present; `<hk:call>` text shim where absent; schema inlined with a worked example where there is no JSON mode; prepend-to-first-user-message where there is no system role.
- [ ] Tolerant parsing + JSON repair (trailing commas, single quotes, unquoted keys, smart quotes, prose around the block), with each repair counted against the model.
- [ ] Catalog cache from `/models` where exposed (id, context, price); raw slugs allowed.
- [ ] Settings API: set master/worker/reviewer model + temperature/max_tokens at runtime; applies to *new* workers only.
- [ ] Master loop: Plan JSON schema (tasks ≤ 8, inputs, expected artifact, success sentence), validation, task enqueue.
- [ ] Worker pool: isolated sessions, depth 1, structured `Result` (status/artifacts/notes/blockers), timeout handling.
- [ ] Code-first result validation: schema → required fields → the task's `success` sentence, before any model judges anything.
- [ ] Three-strike ladder: same model with the **exact validator error** appended → tighter spec, fewer inputs → fallback model → question card.
- [ ] Worker loop guard: 8 tool calls, wall clock, one silent identical retry, and the *third* identical repeat returning "you already did that".
- [ ] Merge step: master folds results, writes final message + artifacts to thread.
- [ ] Spend meter: tokens + USD per job/worker/model persisted, recording model **requested** and model **actually served**, price snapshotted per row, `estimated` flagged when the provider returns no usage; budget breaker stops new completions past cap.
- [ ] Fallback chains: primary → fallback on 429/5xx/outage, surfaced as a system note.
- [ ] Stealth-model banner logic when worker provider is anonymous/free and scope is sensitive.

## Definition of done

- [ ] "Summarize these three URLs into briefing.md" completes in-thread with visible plan card + ≥ 2 parallel workers + merge message.
- [ ] Worker model swapped mid-job: in-flight workers finish old model; next spawn uses new one; no restart.
- [ ] Job exceeding `$2.00` cap halts with a clear card instead of silent overrun.
- [ ] Free/stealth worker on a sensitive job shows the retention warning banner.
- [ ] **The same job completes against a simulated full-capability model and against a simulated model with no tools, no JSON mode, no system role and an 8k window.** This is the product's core claim (G9); it needs a test, not a hope.
- [ ] A corpus of ≥40 real malformed worker outputs parses correctly; every repair kind is counted and attributed.
- [ ] Ladder test: a worker returning invalid JSON twice then valid produces exactly three attempts, and the retry prompt provably contains the validator error text.
- [ ] Second-attempt success is measurably higher with the error appended than without — the test records both numbers and fails if the gap closes.
- [ ] `completion count == spend-log row count` over a full job.
- [ ] CI greps the source and fails if a model id appears outside config/catalog.

Last reviewed: 2026-08-26
