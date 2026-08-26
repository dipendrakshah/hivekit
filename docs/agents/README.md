# Agent files

| File | Loaded by | Purpose |
| --- | --- | --- |
| [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) | Every role | Operating contract: master, worker, reviewer |

Bot persona/instructions live in Settings (stored server-side in SQLite), seeded from a default baked into the Gateway — there are no per-repo template files anymore. Connector notes (site / x / email) are injected by the Gateway at run time.

Starting points for that instructions field live in
[`examples/instructions/`](../../examples/instructions/README.md) — voice, the bar for what is
worth acting on, and the per-thread "never" list. They are text to paste and edit, not a
skills system (PRD §4).

## Prompt assembly, in order

| Layer | Rough budget | Source |
| --- | --- | --- |
| `AGENT_INSTRUCTIONS.md` (role slice) | ~700 tok | this folder, baked in |
| Bot instructions | ~600 tok | Settings → the thread |
| Connector notes | ~300 tok | Gateway, only for connectors in scope |
| Thread history / routine trigger | varies | SQLite |
| Task spec + declared inputs | remainder | the plan (workers only) |

A **worker** never receives thread history, other workers' results, or any credential — only
its task spec and the inputs the plan named. That is what makes workers independently
retryable and keeps a talkative free model from leaking one task's context into another's.

Changing `AGENT_INSTRUCTIONS.md` changes every role on every thread at once, and it is paid on
every call. Keep it short; behaviour that belongs to one thread belongs in that thread's
instructions field.

This folder stays the canonical behavioral contract. See also [../reference/OPENCLAW-NOTES.md](../reference/OPENCLAW-NOTES.md) for historical design notes.
