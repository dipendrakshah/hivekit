# Hivekit

**Your own Grok Bot. On your VM. Your models.**

Hivekit is a tiny self-hosted agent hive inspired by [Grok Bot](https://x.ai/bot) — message a bot like a teammate, it plans, spawns parallel worker bots, does real work through your connectors (website repo, X/Twitter, inbox), and only interrupts you for approvals.

The difference: **you bring the models and the box.**

- One Docker container on any cheap VM (EC2, Hetzner, Fly, Railway).
- Pick a **master model** (planner) and a **worker model** (doers) from any OpenAI-compatible provider — OpenRouter, Anthropic, OpenAI, Groq, local Ollama.
- Workers run in parallel (up to 8) so a strong planner can direct cheap or free workers.
- Recurring chores ("every morning, update my site") become cron **routines**.
- Irreversible actions come back as inline approval cards in the same thread.

This repository is the **v0 design pack**: PRD, architecture, agent contract, UI mock, config, and a milestone backlog. Implementation follows after acceptance.

## Quickstart (target shape)

```sh
ssh my-vm
curl -fsSL https://raw.githubusercontent.com/.../docker-compose.yml -o docker-compose.yml
HIVEKIT_TOKEN=$(openssl rand -hex 24) docker compose up -d
# open https://hive.example.com → set passkey → paste OpenRouter key → say hi
```

## Why this exists

| | Grok Bot | OpenClaw | Hermes Agent | Hivekit |
| --- | --- | --- | --- | --- |
| Thread-first UX (own web app) | ✅ | ❌ (OS-shaped) | ⚠️ third-party chats + ops dashboard | ✅ |
| BYO models | ❌ | ✅ | ✅ (one brain) | ✅ |
| Master ≠ worker split-brain | ❌ | ❌ | ❌ | ✅ |
| Self-host in minutes | ❌ | ❌ (heavy) | ✅ | ✅ (one container) |

OpenClaw is excellent and huge — a personal operating system with 26 channels. [Hermes Agent](https://github.com/NousResearch/hermes-agent) is the closest thing to this list and worth running today; Hivekit exists for the row where it says ❌: a paid planner directing a swarm of free workers through three receipt-audited connectors, from a phone. Hivekit is the opposite bet to OpenClaw: three connectors (site / x / email), one thread, one YAML file, one VM.

## Example jobs (v1 target)

- **Morning site updates** — workers scan five sources in parallel, master drafts a git patch, you approve the diff from your phone.
- **Tweet updates** — master drafts tweet variants in your voice; approve to post via X API.
- **Inbox tracking** — hourly IMAP poll, morning digest in-thread, urgent senders flagged, replies drafted on request.

## Read in this order

1. [PRD.md](PRD.md) — what we are building and what we are not.
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit.
3. [docs/agents/AGENT_INSTRUCTIONS.md](docs/agents/AGENT_INSTRUCTIONS.md) — the operating contract for every model.
4. [docs/ui/app.html](docs/ui/app.html) — UI mock (open in a browser; desktop + phone frames).
5. [examples/example-jobs.md](examples/example-jobs.md) — paste-ready first jobs and routines.
6. [examples/instructions/](examples/instructions/README.md) — starting points for a thread's instructions field.
7. [deploy/README.md](deploy/README.md) — EC2, any VM, Fly/Railway, Cloudflare; backup and connector credentials.
8. [todo/README.md](todo/README.md) — milestone backlog with definitions of done.

## Design principles

1. **Thread is the interface.** Tasks, plans, approvals, artifacts all live in one chat. No workflow builder, ever.
2. **BYOK, not a model company.** Keys are encrypted on your server and never leave it except to call your chosen providers.
3. **Master plans, workers execute, humans approve risk.**
4. **Boring infrastructure.** One Bun process, SQLite, one volume. Backup = copy the volume.
5. **Code verifies; models judge only what code cannot.** Schemas, arithmetic and citation
   checks are free and certain. This is what makes a free worker model viable rather than
   decorative.
6. **Smaller than OpenClaw.** If a feature needs a second paragraph to explain, it probably belongs in v2.

## Honest limits

- Posting to X needs a paid API tier above a small allowance and is subject to X's automation
  rules. `x.post` is approval-gated in every mode; there is no auto-post preset.
- Gmail via API needs OAuth app verification to distribute — the supported path here is IMAP
  with an app password, and SMTP through your own relay (VM IPs have deliverability problems).
- Free and stealth model routes get withdrawn without notice and many retain prompts.
  Fallbacks absorb the first; sensitive scopes refuse stealth providers for the second.
- Always-on means a bill: $4–12/month for the VM plus model spend. A sleeping laptop cannot
  run an 07:00 routine.

## Status

Design / specification. No runtime yet. See `todo/`.

## License

MIT. See [LICENSE](LICENSE).
