# 02 — Tiered memory

Goal: the full `MEMORY.md` system per ARCHITECTURE §4.8 — tiers, write guards, promotion,
retrieval, decay, audits, operator commands. Storage and write path run without any agent
loop; retrieval feeds milestone 3's master prompt.

Split out of 01-foundation (2026-08-26): the foundation box needs none of this to hold a
conversation, and bundling it made milestone 1 unshippable.

## Work

- [ ] Thread workspace: `/data/threads/<slug>/` with `INSTRUCTIONS.md`, `MEMORY.md`, `artifacts/`, `jobs/<id>/`; created on thread creation from the seed templates.
- [ ] `INSTRUCTIONS.md` is the source of truth — Settings reads/writes the file, SQLite stores path + content hash, and an out-of-band edit is detected and reloaded.
- [ ] Tiered memory store: `MEMORY.md` (Pinned · Rules · Facts · State) plus `memory/candidates.jsonl`, `archive.jsonl`, `ledger.jsonl` — the sidecars never enter a prompt.
- [ ] Typed write path: `add-candidate | promote | supersede | retire | update-state`, master-only, once per job, atomic (temp → fsync → rename).
- [ ] Write guards: reject a contradiction without an explicit `supersede(id)`, a near-duplicate, a Rule missing `when`/`wrong-if`, a Fact missing TTL or provenance, or any edit to a Pinned entry.
- [ ] Promotion: a candidate becomes a Rule only after `promote_after` confirmations in **distinct** jobs; operator corrections bypass straight to Pinned.
- [ ] Retrieval assembler: Pinned + State always; Rules and Facts scope-matched and capped at `rules_top_k` / `facts_top_n`. Record every retrieval in the ledger.
- [ ] Decay: retire Rules unused for `retire_unused_after_runs`; expire Facts on TTL.
- [ ] Hold-out audit every `audit_every` runs: one job with retrieval off, compared on approval rate, operator edits, retries and cost.
- [ ] `hivekit memory show|why|pin|retire|candidates|audit`.
- [ ] Memory diff posted into the thread on every write.
- [ ] Optional git-backing (`memory.git`) + `hivekit memory log|diff|revert`.

## Definition of done

- [ ] A `SIGKILL` during a memory write leaves the previous `MEMORY.md` intact and parseable — never a half file.
- [ ] **Prompt size is flat in memory size**: a thread seeded with 400 entries and one with 12 produce master prompts within 10% of each other. The headline test for retrieval.
- [ ] One observation does not create a Rule: a test asserts a single job's finding lands in `candidates.jsonl` and is absent from the assembled prompt; three distinct jobs promote it.
- [ ] A Rule submitted without `wrong-if` is rejected; a Fact without TTL or provenance is rejected.
- [ ] A contradicting write without `supersede(id)` is rejected, and the message names the conflicting entry.
- [ ] Superseding preserves the original wording in `archive.jsonl` — entries are never edited in place.
- [ ] A Rule unused for `retire_unused_after_runs` is retired automatically and leaves the prompt.
- [ ] `hivekit memory why <id>` names the jobs that produced and used the entry, not a summary.
- [ ] A worker asked for `MEMORY.md` is refused; a test asserts it is absent from the worker's rendered prompt.
- [ ] With `memory.git: true`, `hivekit memory revert` restores the previous memory and the next job uses it.

Last reviewed: 2026-08-26
