# Agent files

| File | Loaded by | Purpose |
| --- | --- | --- |
| [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) | Every role | Operating contract: master, worker, reviewer |

A thread's instructions and memory are **two files on the data volume**, not six per-repo
template files and not a blob in SQLite:

| File | Written by | Purpose |
| --- | --- | --- |
| `INSTRUCTIONS.md` | you | voice, the bar for what is worth acting on, the never-list |
| `MEMORY.md` | the master, once per job | active memory in four tiers: Pinned · Rules · Facts · State |
| `memory/*.jsonl` | the master | candidates, archive, usage ledger — **never enter a prompt** |

Memory is **retrieved, not loaded**: a job sees Pinned, State, and the top-K Rules and Facts
whose scope matches it. A thread with 400 remembered entries costs the same per call as one
with 12 ([ARCHITECTURE §4.8.3](../ARCHITECTURE.md)).

The Settings editor reads and writes `INSTRUCTIONS.md` directly; SQLite stores only the path
and a content hash, so there is one store and nothing to drift. Connector notes (site / x /
email) are injected by the Gateway at run time and are not files.

Both files live on the data volume at `/data/threads/<slug>/`, and the file is the source of
truth — the Settings editor reads and writes it, so you can also edit it over SSH or keep the
whole directory in git ([ARCHITECTURE §4.8](../ARCHITECTURE.md)).

Starting points for `INSTRUCTIONS.md` live in
[`examples/instructions/`](../../examples/instructions/README.md) — voice, the bar for what is
worth acting on, and the per-thread "never" list. They are text to paste and edit, not a
skills system (PRD §4).

## Prompt assembly, in order

| Layer | Rough budget | Source |
| --- | --- | --- |
| `AGENT_INSTRUCTIONS.md` (role slice) | ~700 tok | this folder, baked in |
| `INSTRUCTIONS.md` | ~600 tok | `/data/threads/<slug>/` — the file *is* the Settings field |
| Memory · Pinned | ~150 tok | operator corrections, always loaded in full |
| Memory · State | ~100 tok | machine JSON for routine incrementality |
| Memory · Rules | ~400 tok | **top-K scope-matched only**, not the whole file |
| Memory · Facts | ~150 tok | scope-matched, unexpired |
| Connector notes | ~300 tok | Gateway, only for connectors in scope |
| Thread history / routine trigger | varies | SQLite |
| Task spec + declared inputs | remainder | the plan (workers only) |

A **worker** never receives `MEMORY.md`, thread history, other workers' results, or any credential — only
its task spec and the inputs the plan named. That is what makes workers independently
retryable and keeps a talkative free model from leaking one task's context into another's.

Changing `AGENT_INSTRUCTIONS.md` changes every role on every thread at once, and it is paid on
every call. Keep it short; behaviour that belongs to one thread belongs in that thread's
instructions field.

This folder stays the canonical behavioral contract. See also [../reference/OPENCLAW-NOTES.md](../reference/OPENCLAW-NOTES.md) for historical design notes.
