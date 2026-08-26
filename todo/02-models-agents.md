# 02 — Models + master/worker runtime

Goal: the master plans and spawns parallel workers on configurable models; spend is metered; models hot-swap.

## Work

- [ ] Model adapters: `openai_compat` (OpenRouter default, custom base URLs) + `anthropic`; streaming into thread events.
- [ ] Catalog cache from `/models` where exposed (id, context, price); raw slugs allowed.
- [ ] Settings API: set master/worker/reviewer model + temperature/max_tokens at runtime; applies to *new* workers only.
- [ ] Master loop: Plan JSON schema (tasks ≤ 8, inputs, expected artifact, success sentence), validation, task enqueue.
- [ ] Worker pool: isolated sessions, depth 1, structured `Result` (status/artifacts/notes/blockers), timeout handling.
- [ ] Merge step: master folds results, writes final message + artifacts to thread; retry-once on worker failure, then question card.
- [ ] Spend meter: tokens + USD per job/worker/model persisted; budget breaker stops new completions past cap.
- [ ] Fallback chains: primary → fallback on 429/5xx/outage, surfaced as a system note.
- [ ] Stealth-model banner logic when worker provider is anonymous/free and scope is sensitive.

## Definition of done

- [ ] "Summarize these three URLs into briefing.md" completes in-thread with visible plan card + ≥ 2 parallel workers + merge message.
- [ ] Worker model swapped mid-job: in-flight workers finish old model; next spawn uses new one; no restart.
- [ ] Job exceeding `$2.00` cap halts with a clear card instead of silent overrun.
- [ ] Free/stealth worker on a sensitive job shows the retention warning banner.

Last reviewed: 2026-08-26
