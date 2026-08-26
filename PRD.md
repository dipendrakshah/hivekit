# Hivekit Product Requirements Document

Version: 0.1  
Status: Draft for implementation  
Owner: dipendrakshah  
Last updated: 2026-08-26  
Inspired by: OpenClaw (github.com/openclaw/openclaw, formerly Clawd / Clawdbot / Moltbot) and Grok-style master + parallel sub-agents.

---

## 1. Problem

Personal AI agents that *do work* exist, but they fail one of two ways:

1. **Too heavy.** OpenClaw is a full local-first operating system: Gateway, 26 channels, nodes, skills marketplace, heartbeats, pairing, sandboxes. Powerful. Not a weekend setup.
2. **Too closed.** ChatGPT / Claude / Grok apps pick the model for you. You cannot say "master is Claude Fable 5, workers are free Ox Alpha on OpenRouter, fallback is local Ollama."

People who want a personal workshop — update a news site, crunch invoices into a tax dashboard, babysit a folder of files — need a third path:

- Bring any model key (provider or gateway).
- Configure master vs worker independently.
- Spin cheap or free workers in parallel.
- Get files out, not just chat.

## 2. Product statement

Hivekit is a **personal multi-agent workshop**. A single long-running Gateway on a machine or cheap VPS talks to three thin clients (macOS Electron, Android, cloud web). The operator pastes keys, names a master model and a worker model, and gives jobs. The master decomposes. Workers execute against files and tools. Results land in a workspace the operator can open.

Hivekit is not a social bot, not a 20-agent octopus, and not a hosted model company.

## 3. Goals

| ID | Goal | Metric |
| --- | --- | --- |
| G1 | First useful job in one sitting | New operator goes from clone to a completed sample job in ≤ 15 minutes |
| G2 | Model-agnostic | Any OpenAI-compatible endpoint works; OpenRouter is the default gateway |
| G3 | Split brain | Master model and worker model are independently set and hot-swappable |
| G4 | Parallel cheap workers | One job can fan out to N workers (default 4, max 16 in v1) |
| G5 | File-native work | Jobs read/write PDF, HTML, CSV/XLSX, JSON, Markdown, images, source trees |
| G6 | Three surfaces, one brain | Electron macOS, Android, cloud web share one Gateway protocol |
| G7 | Safer than a raw shell bot | Destructive actions require approval; keys never leave the vault |

## 4. Non-goals (v1)

- WhatsApp / Telegram / Discord / iMessage gateways (OpenClaw already owns this).
- Self-evolving agent that rewrites its own code in production.
- Multi-tenant SaaS with Hivekit-billed inference.
- Crypto trading, phone calling, desktop click-automation.
- 1,024-way fan-out. Cap is 16 workers per job in v1.
- Replacing OpenClaw. Hivekit is the thin workshop; OpenClaw remains the full personal OS.

## 5. Personas

**Operator (primary)** — a builder who has an OpenRouter or Anthropic key, a laptop, and a recurring chore (news site, taxes, research dump). Wants YAML, not a sales call.

**On-the-go operator** — same person on a phone. Starts or inspects a job, approves a risky step, reads a summary. Does not configure models on a 6-inch screen beyond picking presets.

**Future contributor** — reads AGENT_INSTRUCTIONS.md and can add a skill without touching the Gateway core.

## 6. Core user journeys

### 6.1 First-run (happy path)

1. Install Gateway (`hivekit init` or Docker).
2. Paste OpenRouter key (or any provider key).
3. Pick master = `anthropic/claude-sonnet` (or Fable when available) and worker = `stealth/ox-alpha`.
4. Run sample job "Summarize these three PDFs into one briefing.md".
5. Open the artifact in the workspace.

Done when the briefing file exists and the job timeline shows master plan + worker results + merge.

### 6.2 Recurring news site

1. Operator points Hivekit at a git repo or folder that is a static site.
2. Skill `news-site` schedules a heartbeat every morning.
3. Master assigns: source scout, writer, fact checker, publisher.
4. Workers fetch RSS / pages, draft posts, check claims, commit HTML.
5. Operator gets a digest on all three clients.

### 6.3 Tax history dashboard

1. Operator drops invoices (PDF, JPG, CSV) into `inbox/tax/2025`.
2. Master plans extract → normalize → categorize → render dashboard.
3. Workers OCR / parse in parallel.
4. Artifact is an HTML + JSON dashboard the operator can open locally or publish.

### 6.4 Model swap mid-project

1. Ox Alpha free window ends or rate-limits.
2. Operator edits `models.worker` to `meta-llama/...` or `openai/gpt-...`.
3. Next worker spawn uses the new model. In-flight workers finish on the old one.
4. No rebuild, no code change.

## 7. Functional requirements

### 7.1 Model layer

- FR-M1. Support providers: OpenRouter, OpenAI, Anthropic, Google, Groq, Together, Fireworks, Ollama / LM Studio (OpenAI-compatible), any custom base URL.
- FR-M2. Store keys in OS keychain (macOS), encrypted vault on server, never in git.
- FR-M3. Config fields per role: `master.model`, `worker.model`, optional `reviewer.model`.
- FR-M4. Per-role overrides: temperature, max tokens, timeout, reasoning effort if the provider exposes it.
- FR-M5. Fallback chain per role (`primary`, `fallback`).
- FR-M6. Cost and token accounting per job, per worker, per model id.
- FR-M7. Free / stealth models work with no special case beyond `price: 0` in the catalog cache.

### 7.2 Master / worker runtime

- FR-A1. Master receives the operator message + workspace index + skill match.
- FR-A2. Master emits a structured plan: list of tasks with inputs, expected artifact, worker count, success criteria.
- FR-A3. Gateway spawns workers with isolated context by default (OpenClaw-style `context: isolated`).
- FR-A4. Workers cannot spawn more workers in v1 (`maxSpawnDepth: 1`).
- FR-A5. Workers report a structured result: status, artifact paths, notes, failures.
- FR-A6. Master merges, may request a reviewer pass, then marks the job done or asks the operator.
- FR-A7. Operator can stop a job, pause workers, or reassign a single task to another model.
- FR-A8. Heartbeat jobs run on a cron without a chat message.

### 7.3 Workspace and files

- FR-F1. Each Hivekit instance has one default workspace; additional named workspaces are allowed.
- FR-F2. Standard files: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `IDENTITY.md`, `HEARTBEAT.md`.
- FR-F3. Tools: read, write, edit, list, search, run (allowlisted), fetch URL, parse PDF, parse office docs, render HTML preview.
- FR-F4. Binary files are hashed and stored; models receive extracted text + thumbnail, not raw bytes unless the model is multimodal.
- FR-F5. Jobs write under `jobs/<job-id>/` and promote finished artifacts to `out/`.

### 7.4 Clients

- FR-C1. Electron macOS: chat, job timeline, swarm view, model settings, workspace browser, approval sheet.
- FR-C2. Android: chat, job list, approve/deny, artifact preview, model preset picker.
- FR-C3. Cloud web: same as Electron minus native file dialogs; auth via magic link or passkey; Gateway may run on the same host or a remote URL.
- FR-C4. All clients speak one WebSocket protocol to the Gateway.

### 7.5 Safety

- FR-S1. Modes: `ask` (default), `auto` (allowlisted tools only), `strict` (read-only plus explicit allow).
- FR-S2. Always ask: shell that is not allowlisted, delete, git push, spend over budget, send external email.
- FR-S3. Secrets redacted in logs and in worker transcripts sent back to the master.
- FR-S4. External untrusted content (web pages, email, PDFs) is wrapped before it enters a prompt.

## 8. Non-functional requirements

- NFR-1. Gateway starts in < 3 seconds on a modern laptop.
- NFR-2. First token from a local-routed chat < 800 ms after provider TTFB.
- NFR-3. Workspace of 10k files indexes incrementally.
- NFR-4. Offline: clients show last job state; new inference requires the configured provider (or Ollama).
- NFR-5. Single-operator v1. No team IAM beyond one admin token.
- NFR-6. MIT license, no CLA theater.

## 9. Configuration sketch

See `config/hivekit.example.yaml`. The product promise is: **if you can edit that file, you can run Hivekit.**

## 10. Competitive position

| | OpenClaw | Grok / ChatGPT apps | Hivekit |
| --- | --- | --- | --- |
| Setup | Rich, many surfaces | Zero | One command + one YAML |
| Models | Any | Vendor locked | Any, master ≠ worker |
| Sub-agents | Yes, deep | Native in some Grok modes | Yes, shallow (depth 1) |
| Channels | 26 | Vendor apps | Own three clients in v1 |
| Jobs as files | Workspace + skills | Mixed | First-class |
| Target | Personal OS | Consumer chat | Personal workshop |

## 11. Risks

- Free stealth models disappear or retain prompts. Mitigate: warn in UI, allow local-only mode, never send tax IDs to anonymous providers by default.
- Master/worker heterogenous models disagree on format. Mitigate: strict JSON schemas for plan and result.
- Electron + Android + web triples UI work. Mitigate: one web UI; Electron wraps it; Android uses the same API with a native shell.
- Scope creep toward OpenClaw. Mitigate: this PRD's non-goals are binding until a v2 PRD exists.

## 12. Success criteria for v1 launch

1. Sample news-site job completes unattended after first approval of git write.
2. Sample tax-dashboard job produces an HTML file from ≥ 10 mixed invoices.
3. Switching worker model mid-session requires only a config change and a restart of *new* workers.
4. A stranger can follow README + `hivekit init` and finish the PDF briefing job without opening a source file.

## 13. Open questions

- Should v1 ship a Telegram *listener* as an optional plugin, or stay client-only?
- Do we vendor a tiny PDF/OCR pipeline or shell out to existing tools?
- Cloud web: operator-hosted only, or a one-click Fly/Railway template?

Default answers for v1: client-only messaging, shell-out for OCR with a documented tool, operator-hosted plus a compose file.
