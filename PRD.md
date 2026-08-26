# Hivekit Product Requirements Document

Version: 0.2
Status: Draft for implementation
Owner: dipendrakshah
Last updated: 2026-08-26
Inspired by: Grok Bot (x.ai/bot) — thread UX, parallel bots, inline approvals, show-it-once routines. Deliberately **not** OpenClaw.

---

## 1. Problem

Grok Bot got the shape right: you message a bot like a teammate, it does real work in your tools, it only comes back when approval is needed. But it is closed:

1. **Vendor-locked models.** You cannot choose the brain. You cannot say "master is Claude, workers are a free stealth model on OpenRouter."
2. **Their cloud, their subscription.** Your jobs run on xAI infrastructure behind plan gates.
3. **No self-hosting.** Your email, your site repo, your accounts — all proxied through someone else's product.

OpenClaw solves the openness problem but is a full personal OS: 26 channels, nodes, skills marketplace. Not a weekend deploy.

The missing product: **a tiny, self-hosted Grok Bot where you bring the models.**

## 2. Product statement

Hivekit is a **self-hosted agent hive with Grok-Bot simplicity**. One container on any cheap VM (EC2, Hetzner, Fly, Railway). You open one web app (desktop or phone browser), paste an API key, pick a **master model** and a **worker model**, and start messaging.

The master plans. Workers execute in parallel through built-in connectors — your website's git repo, your X/Twitter account, your inbox. Irreversible steps come back as inline approval cards in the same thread. Recurring work ("every morning, update my site") is saved as a **routine** that fires on cron.

If you can run `docker compose up` on a $5 VPS, you can run Hivekit.

## 3. Goals

| ID | Goal | Metric |
| --- | --- | --- |
| G1 | Deploy in one sitting | Fresh EC2/VPS box → logged-in hive → first completed job ≤ 15 minutes |
| G2 | BYOM, split brain | Master and worker models independently set; hot-swappable mid-session |
| G3 | Thread is the interface | Chat thread carries tasks, plans, worker updates, approvals, artifacts |
| G4 | Parallel cheap workers | One job fans out to N workers (default 4, max 8 in v1) |
| G5 | Real connectors v1 | Website (git publish), X/Twitter (post), Email (IMAP read / SMTP send) |
| G6 | Routines | Any job can become a cron routine from the thread |
| G7 | Safe defaults | External/irreversible actions always require approval; keys encrypted at rest |

## 4. Non-goals (v1)

- Native Electron or Android apps. One responsive web app serves desktop + phone.
- Channel zoo (WhatsApp/Telegram/Discord/iMessage). Three connectors only.
- Workflow builder, node graphs, setup wizards.
- Skills marketplace or plugin system. Bot behavior = instructions field + routines.
- Workers spawning workers (`maxSpawnDepth: 1`). Multi-tenant SaaS. Hivekit-billed inference.
- Laptop-daemon as primary mode. It may work locally, but v1 targets an always-on cloud VM.

## 5. Personas

**Operator (only persona)** — an indie builder who owns a website repo, an X account, and an inbox that needs watching. Has an OpenRouter or Anthropic key. Wants to hand off recurring chores from a phone while the hive runs on a VM.

## 6. Core user journeys

### 6.1 First-run on EC2

1. `ssh` into the box, copy `docker-compose.yml`, `docker compose up -d`.
2. Open `https://hive.example.com`, set owner passkey on first login.
3. Paste OpenRouter key. Pick master = `anthropic/claude-sonnet`, worker = free stealth model.
4. Message: "Summarize these three URLs into briefing.md." Master plans, two workers fetch in parallel, artifact lands in the thread.

Done when the file exists and the timeline shows plan → workers → merge.

### 6.2 Morning website updates (routine)

1. Operator messages: "Every morning at 07:00 IST, check these five sources for news about X, draft updates for my site repo, and show me the diff before pushing."
2. Routine saved. Next morning: master assigns source-scanning to 4 workers in parallel, drafts the patch.
3. Approval card appears in-thread: diff preview + Approve / Edit / Deny.
4. On approve: commit + push to the site repo. Digest posted back to the thread.

### 6.3 Tweet updates

1. "When I publish a post, draft three tweet variants in my voice."
2. Master drafts variants; operator taps one → approval card → posts via X API.
3. Optional routine: weekly digest of engagement stats into the thread.

### 6.4 Email tracking

1. "Watch my inbox, summarize unread every morning, flag anything from clients as urgent."
2. Hourly IMAP poll. Morning digest message in-thread; urgent items pinned.
3. Reply drafts on request. **Sending external email always asks.**

### 6.5 Model swap mid-project

1. Free worker window ends or rate-limits.
2. Operator edits worker model in Settings (or YAML).
3. Next spawned workers use the new model; in-flight workers finish on the old one. No rebuild.

## 7. Functional requirements

### 7.1 Models

- FR-M1. Providers: OpenRouter (default), OpenAI, Anthropic, Google, Groq, Together, Fireworks, Ollama/LM Studio, any custom base URL.
- FR-M2. Keys encrypted at rest on the server (AES-GCM with env-derived master key). Never returned to clients after save. Never in git.
- FR-M3. Per-role config: `master.model`, `worker.model`, optional `reviewer.model`.
- FR-M4. Per-role overrides: temperature, max tokens, timeout.
- FR-M5. Fallback chain per role (`primary`, `fallback`), auto-switch on 429/outage.
- FR-M6. Cost + token accounting per job, per worker, per model. Shown in-thread and in Settings.
- FR-M7. Free/stealth models are first-class (`price: 0` catalog entries), with a visible warning when routed sensitive data.

### 7.2 Master / worker runtime

- FR-A1. Master receives the operator message (+ routine trigger) plus an index of recent artifacts.
- FR-A2. Master emits a structured plan (JSON): tasks, inputs, expected artifact, success criteria.
- FR-A3. Gateway spawns up to 8 workers with isolated contexts.
- FR-A4. Workers report structured results: status, artifact paths, notes, blockers.
- FR-A5. Master merges results and writes the final answer/artifact into the thread.
- FR-A6. Worker failure: master retries once with a tighter spec, then surfaces a question card. Never silently drops.
- FR-A7. Operator can stop a job or reassign a single task to another model mid-flight.

### 7.3 Connectors

- FR-K1. **web**: fetch URLs/RSS feeds; content wrapped as untrusted input. Parallel fetching is the default fan-out pattern.
- FR-K2. **site**: publish to the operator's website via git (clone once, branch, commit, push). Push requires approval with diff preview. Read-only repo access suffices for draft-only mode.
- FR-K3. **x**: post tweets via X API v2. All sends are drafted first; sending requires approval. Media attach in v1.1.
- FR-K4. **email**: IMAP poll (app-password based, e.g. Gmail), classify/triage/draft. SMTP send requires approval. Poll interval configurable per routine.
- FR-K5. Connector credentials live in the server vault, configured once in Settings → Connectors.
- FR-K6. Every connector action produces an audit receipt (who/what/when/model/approved-by).

### 7.4 Routines

- FR-R1. Created conversationally: the master parses plain language ("every morning at 07:00 IST, watch these five sources …") into `{cron, prompt_template, connector_scope, notify_policy}` and saves only after an inline confirm card. A New Routine form exists as the fallback path.
- FR-R2. Notify policies: `always`, `on-approval-only` (default), `silent-until-done`.
- FR-R3. Missed runs (VM rebooted) run catch-up once, flagged as late.
- FR-R4. Pause/resume/edit from the Routines tab without deleting history.

### 7.5 Clients

- FR-C1. One responsive web app served by the Gateway itself. Desktop layout: nav rail + thread + status rail. Mobile: bottom tabs + full-width thread.
- FR-C2. WebSocket (WSS) for live updates; REST fallback not required in v1.
- FR-C3. Auth: owner passkey set on first login; session cookies; HTTPS terminated by Caddy or Cloudflare in front of the box.
- FR-C4. Artifacts render inline: markdown, HTML preview, images, CSV tables, plain diffs.

### 7.6 Safety

- FR-S1. Modes: `ask` (default), `auto` (allowlisted read-only tools), `strict` (nothing external without explicit per-action allow).
- FR-S2. Always ask regardless of mode: git push, tweet send, external email, delete, spend over budget, shell outside allowlist.
- FR-S3. Secrets redacted in logs and in worker transcripts sent to masters/providers.
- FR-S4. Untrusted external content (pages, emails, RSS) wrapped before entering prompts; instructions inside untrusted content are never followed.

## 8. Non-functional requirements

- NFR-1. Single Node process + SQLite (WAL). No second database. One volume to back up.
- NFR-2. Gateway restart < 5 s; jobs resume from persisted state after crash/reboot.
- NFR-3. First token latency ≈ provider TTFB + < 100 ms gateway overhead.
- NFR-4. Runs comfortably on 1 vCPU / 1 GB RAM (EC2 t4g.nano class).
- NFR-5. Single-operator. One admin token/passkey. No team IAM in v1.
- NFR-6. MIT license.

## 9. Deployment

Supported shapes, same container:

1. **Any VM** (EC2 Lightsail/t4g.nano, Hetzner, DigitalOcean): Docker Compose with Caddy (auto-TLS) + Hivekit + volume.
2. **Fly.io / Railway**: one service + attached volume.
3. **Cloudflare**: Cloudflare has no general-purpose VM — the supported pattern is DNS proxy + Cloudflare Tunnel in front of a VM running Hivekit. Long-lived WebSockets rule out Workers as the host.

Config surface stays one small YAML (see `config/hivekit.example.yaml`) plus in-app Settings. The promise: if you can edit that file, you can run Hivekit.

## 10. Competitive position

| | Grok Bot | OpenClaw | Hermes Agent | Hivekit |
| --- | --- | --- | --- | --- |
| Shape | Thread-first teammates | Personal OS | CLI/TUI agent + chat-channel gateway + ops dashboard | Thread-first, single container, one web app |
| Models | Vendor-locked | Any | Any, one model per profile | Any, **master ≠ worker** split-brain |
| Hosting | xAI cloud, plan-gated | Your machines, heavy install | Your $5 VPS | Your $5 VM in 10 minutes |
| Parallel workers | Yes (proprietary) | Yes, deep | Isolated subagents on the same model | Cheap/free workers fanned out under a strong master |
| Connectors | Their tool integrations | 26 channels | Generic tools + MCP + browser automation | 3 focused: site, x, email |
| Recurring work | Routines | Heartbeat | Natural-language cron | Natural-language routines (cron) |
| Trust surface | Undocumented audit | Local by design | Command approval + container isolation | Inline approval cards with diff/payload preview + browsable receipts |

Hermes Agent is the closest existing system and proves the demand for self-hosted BYOM agents. Hivekit's remaining reasons to exist against it: the split-brain economics (paid planner directing a free worker swarm), a purpose-built Grok-Bot-shaped web thread instead of TUI + third-party chats, three connectors with receipt-grade approvals rather than generic tool access, and a codebase small enough for one person to fully audit.

## 11. Risks

- **X API tiers/costs** may constrain posting volume. Mitigate: draft-by-default means low API usage; document tier limits.
- **Email sending from EC2 IPs** has deliverability/reputation issues. Mitigate: v1 is receive-heavy (IMAP); sending goes through the operator's own SMTP relay (e.g., Gmail app password or transactional provider).
- **Heterogeneous master/worker models** disagree on formats. Mitigate: strict JSON schemas for plans/results; retry-once policy.
- **Scope creep toward OpenClaw.** Mitigate: non-goals §4 are binding until a v2 PRD exists.

## 12. Success criteria for v1 launch

1. A stranger follows README → running hive on EC2 in ≤ 15 min, first job done in-thread.
2. Website routine fires overnight unattended; morning state = diff awaiting approval in the thread; approving pushes the commit.
3. Tweet flow: draft variants → approve → post, end to end from a phone browser.
4. Inbox digest arrives each morning; urgent sender flagged correctly.
5. Switching worker model mid-session is a Settings change; new workers pick it up with no restart.

## 13. Open questions

- Reviewer role: ship in v1 or defer to v1.1? Default: defer; master self-checks.
- Notification push when the tab is closed: web push vs daily email digest? Default: email digest via the operator's SMTP.
- Fourth connector (LinkedIn/Telegram listener)? Out of scope until v2 PRD.
