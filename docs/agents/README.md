# Agent files

| File | Loaded by | Purpose |
| --- | --- | --- |
| [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) | Every role | Contract: master, worker, reviewer |
| ../../templates/workspace/SOUL.md | Every session | Tone |
| ../../templates/workspace/USER.md | Every session | Operator facts |
| ../../templates/workspace/IDENTITY.md | Every session | Hive name |
| ../../templates/workspace/TOOLS.md | Every session | Local tool notes |
| ../../templates/workspace/HEARTBEAT.md | Gateway scheduler | Cron jobs |
| ../../templates/workspace/AGENTS.md | Every session | Workspace-local additions |

When the runtime exists, `hivekit init` copies the templates into `~/.hivekit/workspace`. This folder stays the canonical contract.
