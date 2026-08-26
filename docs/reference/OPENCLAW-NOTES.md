# Notes from OpenClaw (Clawd) and Grok-style agents

Hivekit is a *reduction* of ideas that already work. This file records what we borrowed so implementers do not have to reverse-engineer 80k commits.

Sources consulted 2026-08-26:

- https://github.com/openclaw/openclaw (OpenClaw, formerly Clawd / Clawdbot / Moltbot)
- https://docs.openclaw.ai and community overview at clawdocs.org
- Public write-ups of Grok multi-agent / Grok Build sub-agents
- OpenRouter listing for Ox Alpha (`stealth/ox-alpha`)

## Borrowed from OpenClaw

- **One Gateway process** as the only control plane. Clients are dumb.
- **Workspace markdown** as durable memory: `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`.
- **Skills as `SKILL.md`** folders. Catalog line in context; full body on match.
- **Isolated child sessions** for sub-agents, announce-back to parent, depth and concurrency caps.
- **Doctor command** mentality: fix the machine before blaming the model.
- **Untrusted content markers** around fetched text.

## Deliberately not borrowed

- Messaging channel matrix (WhatsApp, Telegram, Discord, iMessage, …).
- Device nodes (camera, location, canvas as first-class).
- Plugin marketplace and ACP/A2A protocol zoo in v1.
- Dreaming / presence / multi-identity routing.

## Borrowed from Grok-style multi-agent

- A **captain / master** that decomposes and synthesizes.
- **Parallel workers with clean context**, not one giant shared transcript.
- A **reviewer / critic** lane (optional in Hivekit).
- Fan-out upper bound. Grok Build has talked about hundreds to 1,024; Hivekit v1 stops at 16 so a free-model weekend does not melt a key.

## Ox Alpha / 0xAlpha

Community shorthand `0xAlpha` maps to OpenRouter slug `stealth/ox-alpha` (appeared 2026-08-20): large context, tool use, $0 during preview, anonymous provider that may retain prompts. Hivekit treats it as a **worker default candidate**, never as a silent default for tax or identity skills.

## Claude Fable and Meta routes

PRD examples use Claude Fable 5 as a plausible **master** and a Meta Llama / Muse-class model as a plausible **worker**. Slugs change. The architecture depends on **roles**, not on a frozen catalog. The UI must let the operator type any model id.
