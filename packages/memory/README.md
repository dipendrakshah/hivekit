# @hivekit/memory

Tiered thread memory per ARCHITECTURE §4.8 and todo/02. Storage and write path
run **without any agent loop** — this package knows nothing about models,
frames or connectors, which is exactly why it can be tested exhaustively.

## Layout it owns (one thread dir)

```
<root>/MEMORY.md                 four tiers: Pinned · Rules · Facts · State
<root>/memory/candidates.jsonl   observations waiting for evidence (+ consumed ones, retained)
<root>/memory/archive.jsonl      superseded/retired entries, ORIGINAL wording preserved
<root>/memory/ledger.jsonl       retrievals, lifecycle events, audits — `why` reads this
```

## Public surface

| Export | Role |
| --- | --- |
| `MemoryStore.apply(jobId, ops[], run)` | typed write path (`add-candidate │ promote │ supersede │ retire │ update-state`), two-phase, once-per-job, all-or-nothing |
| `assemble(mem, {scope, jobId, run}, cfg)` | master-prompt block ONLY (Pinned + State always; Rules top-K; Facts top-N, unexpired) |
| `retireUnusedRules(store, currentRun)` | decay pass; retired rules land in archive with reasons |
| `GitBacking(threadsDir, enabled)` | §4.8.9 history: `thread/<slug>` commits, `log│diff│revert` |
| `runMemoryCli(argv, threadsDir)` | `show│why│pin│retire│candidates│audit` |

## Integration contract for stream 03 (read before wiring)

1. **Master context** = `INSTRUCTIONS.md` + `assemble().promptBlock` + matched
   connector notes. Nothing else may append memory bytes to a prompt.
2. **Workers never see memory.** This package exports NO worker renderer by
   design; a test pins `renderWorkerPrompt`'s absence from the public surface.
3. The gateway calls `recordLedger({kind:"retrieval", entry_id, run, job_id, …})`
   after every assembly (helper: `recordRetrievals`). Ledger rows are what make
   retirement and `why` honest.
4. One write per job is enforced inside `apply()` — pass the real job id.
5. Hold-out *audit execution* (running one job with retrieval off and comparing)
   lives in stream 03; this package provides `recordLedger({kind:"audit",…})`
   plus `store.audits()` and CLI rendering.
6. `threads_dir` (e.g. `/data/threads`) is BOTH the GitBacking repo root AND
   `runMemoryCli`'s scan root — slugs sit directly beneath it.

## Tests

```sh
bun test packages/memory/
```

27 tests map directly onto the todo/02 DoD claims (guards naming conflicting
ids, promotion needing DISTINCT jobs, archive wording preservation, prompt-size
flatness within 10% across 12-vs-400-entry threads, decay, `why` naming jobs,
crash-between-fsync-and-rename durability, git revert).
