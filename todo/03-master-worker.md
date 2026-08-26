# 03 — Master / worker runtime

## What to do

Implement the two loops in ARCHITECTURE.md §4.3.

Work:

1. Plan JSON schema + validator (≤ 16 tasks, depth 1, artifacts named).
2. Worker session factory: isolated transcript, injected ROLE=worker, only listed input files.
3. `job.submit_result` tool.
4. Announce-back: worker terminal state wakes master merge.
5. Timeouts per task and per job.
6. Cancel: cooperative abort of in-flight HTTP and mark remaining tasks cancelled.
7. Concurrency pool (`max_workers_per_job`).
8. Optional reviewer loop behind `roles.reviewer.enabled`.

## Definition of done

- [ ] A fixture job with 3 dummy workers produces 3 isolated transcripts and one merge report.
- [ ] Workers cannot call spawn. Test asserts the tool is absent from their tool list.
- [ ] Master cannot `submit_result`. Test asserts tool absent.
- [ ] Killing the job mid-flight leaves SQLite in `cancelled`, no zombie HTTP after timeout.
- [ ] Bad plan JSON from the master is rejected and the master is asked to repair once; second failure surfaces to the operator.
- [ ] Depth cap is enforced in code, not only in the prompt.
