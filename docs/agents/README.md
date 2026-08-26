# Agent files

| File | Loaded by | Purpose |
| --- | --- | --- |
| [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) | Every role | Operating contract: master, worker, reviewer |

Bot persona/instructions live in Settings (stored server-side in SQLite), seeded from a default baked into the Gateway — there are no per-repo template files anymore. Connector notes (site / x / email) are injected by the Gateway at run time.

This folder stays the canonical behavioral contract. See also [../reference/OPENCLAW-NOTES.md](../reference/OPENCLAW-NOTES.md) for historical design notes.
