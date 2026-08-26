# Notes from OpenClaw (Clawd) and Grok-style agents

> **Archived reference (v0.1 era).** The v0.2 PRD pivoted to a self-hosted Grok-Bot shape: workspace persona files and skills folders were dropped in favor of Settings-stored instructions and routines. Kept for design archaeology.

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

---

## The one idea neither reference system has

**Master and worker are different models, chosen by you.**

Grok Bot runs xAI models. OpenClaw lets you pick a model but does not make the
planner/executor split a first-class configuration axis. That split is Hivekit's entire
economic argument: a capable model plans and merges (2–3 calls), free models do the volume
(4–8 calls), and code — not a model — checks the results. A morning routine lands around
$0.03–0.10, roughly 90% of it the master.

It only works because of two mechanisms that neither reference system needed:

1. **Capability-aware rendering** ([ARCHITECTURE §4.4.1](../ARCHITECTURE.md)) — a model with
   no tool calling, no JSON mode, no system role and an 8k window is still a usable worker.
   Without it, "bring any model" quietly means "bring any frontier model".
2. **Code-first verification with a specific-error retry**
   ([§4.4.2](../ARCHITECTURE.md)) — a weak model's mistakes are caught in milliseconds by a
   validator and retried with the exact error attached, rather than being published.

## Where Hivekit is stricter than both

**Untrusted content reduces capability.** Both reference systems wrap fetched content and
instruct the model not to obey it. Hivekit does that *and* removes `site.push`, `x.post`,
`email.send` and `exec.run` from any task holding untrusted content — the tools are absent,
not denied. Wrapping is necessary and insufficient; removal is what holds against a payload
that fully convinces the model.
