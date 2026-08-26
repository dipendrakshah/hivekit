# Hivekit System Architecture

Version: 0.1  
Companion to [PRD.md](../PRD.md).  
Reference systems: OpenClaw Gateway + workspace files; Grok-style orchestrator with parallel sub-agents.

---

## 1. One-sentence architecture

A single **Gateway** process holds sessions, model clients, the job graph, and tool execution. Thin **clients** attach over WebSocket. A **master agent** writes a plan; the Gateway **spawns workers** with their own context; workers write files and return structured results; the master merges.

```
 Operator
    │
    ├── Electron (macOS)  ─┐
    ├── Android app       ─┼── WebSocket (JSON frames) ──► Gateway :8787
    └── Cloud web app     ─┘                                    │
                                                                │
                    ┌───────────────────────────────────────────┼──────────────┐
                    │ Gateway                                   │              │
                    │  ┌─────────┐  ┌──────────┐  ┌──────────┐  │  ┌────────┐  │
                    │  │ Router  │  │ Job graph│  │ Vault    │  │  │ Index  │  │
                    │  └────┬────┘  └────┬─────┘  └────┬─────┘  │  └───┬────┘  │
                    │       │            │             │        │      │       │
                    │  ┌────▼────────────▼─────────────▼────────▼──────▼────┐  │
                    │  │              Agent runtime                         │  │
                    │  │   Master loop  ◄── plan / merge / ask human        │  │
                    │  │   Worker pool  ◄── isolated sessions, depth = 1    │  │
                    │  └──────────────┬─────────────────────┬───────────────┘  │
                    │                 │                     │                  │
                    │          Model adapter          Tool bus                 │
                    │          (OpenAI-compat)        (fs, fetch, pdf, exec)   │
                    └─────────────────┼─────────────────────┼──────────────────┘
                                      │                     │
                         OpenRouter / Anthropic /     Workspace on disk
                         Ollama / custom base URL     ~/.hivekit/workspace
```

## 2. Design differences from OpenClaw

OpenClaw is the right *shape* (Gateway, workspace markdown, skills as `SKILL.md`, isolated agent sessions, spawn + announce back). Hivekit deletes most of the surface area:

| OpenClaw | Hivekit v1 |
| --- | --- |
| Channels: WhatsApp, Telegram, Slack, Discord, Signal, iMessage, … | Only Hivekit clients |
| Nodes with camera / location / canvas | No device nodes. Android is a client, not a sensor node |
| Plugin marketplace (ClawHub) | A `skills/` folder in the repo |
| Multi-agent *routing* across identities | One operator, many *workers* inside a job |
| Heartbeat + dreaming + presence | Heartbeat cron only |
| Depth-configurable sub-agents | Hard cap: depth 1, max 16 children |

We keep the part that matters: **markdown workspace as memory**, **spawn isolated children**, **announce results to parent**.

## 3. Processes and deploy shapes

Three legal deploy shapes. Same binary.

1. **Laptop.** Gateway + Electron on one Mac. Workspace is a local folder. Default for development.
2. **Always-on box.** Gateway on a small VPS or home server. Electron and Android talk to it over Tailscale / SSH tunnel / HTTPS. Workspace lives on the box.
3. **Cloud workshop.** Gateway + web UI in Docker Compose (Caddy + Gateway + optional Ollama). Operator logs into the web app. Files persist on a volume.

Android never runs the Gateway in v1.

## 4. Gateway internals

### 4.1 Control plane

WebSocket on `127.0.0.1:8787` by default. Remote bind is off until the operator sets `gateway.expose` and a token.

Frame types (deliberately smaller than OpenClaw):

- `req.hello` → snapshot (health, models, active jobs)
- `req.chat` → user message into a session
- `req.job.start` / `req.job.cancel` / `req.job.approve`
- `req.models.set` (master / worker / reviewer)
- `req.fs.list` / `req.fs.read` (workspace only)
- `event.job` (graph updates)
- `event.agent` (token stream)
- `event.approve` (human-in-the-loop)

Idempotency keys on `job.start`, `job.approve`, `job.cancel`.

### 4.2 Job graph

A job is a directed acyclic graph stored in SQLite.

```
Job
  id, title, skill, workspace, status
  master_model, worker_model
  budget_tokens, budget_usd
  created_at, finished_at

Task
  id, job_id, parent_task_id (null for roots)
  title, spec_json, status
  assignee (master | worker | reviewer | human)
  model_id
  artifact_paths_json
  error
```

States: `queued → running → needs_approval → merging → done | failed | cancelled`.

### 4.3 Agent runtime

Two loops, one codebase.

**Master loop**

1. Load `SOUL.md` + `AGENTS.md` + `USER.md` + matched `SKILL.md` + workspace index snippet.
2. Ask master model for a `Plan` object (JSON schema).
3. Validate plan (task count ≤ 16, no nested spawn, artifacts named).
4. Enqueue tasks.
5. On each worker `Result`, fold into a running synthesis.
6. When all tasks terminal, ask master for `Merge` (or skip if single task).
7. Write `jobs/<id>/REPORT.md` and promote artifacts.

**Worker loop**

1. Fresh session. System prompt = worker slice of AGENT_INSTRUCTIONS + task spec + only the files listed in the spec.
2. Tool loop until `submit_result` or timeout.
3. Gateway posts `Result` onto the job graph. Master is woken. Worker session is archived.

Workers do not see other workers' transcripts. That is the Grok-Build lesson: isolated context beats a shared soup.

### 4.4 Model adapter

One interface:

```
complete({
  model,
  messages,
  tools,
  json_schema?,
  timeout_ms,
  max_tokens
}) -> stream | object
```

Adapters:

- `openai_compat` (OpenRouter, Groq, Together, Ollama, LM Studio, custom)
- `anthropic` (native messages + tools)
- `google` (optional in v1.1)

OpenRouter is the blessed path because one key unlocks Claude Fable, Ox Alpha (`stealth/ox-alpha`), Llama/Muse-class Meta models, and dozens of free or cheap workers.

Catalog cache: on boot, if the provider exposes `/models`, Hivekit stores id, context length, modality, price. The UI picker reads the cache. Unknown ids are still allowed — the operator may type a raw slug.

### 4.5 Tool bus

Tools are functions with JSON schemas. Policy sits in front of the bus.

| Tool | Default policy (`ask` mode) |
| --- | --- |
| `fs.read` `fs.list` `fs.search` | allow in workspace |
| `fs.write` `fs.edit` | allow under `jobs/` and `out/`; ask elsewhere |
| `web.fetch` | allow, content marked untrusted |
| `pdf.extract` `office.extract` | allow |
| `exec.run` | ask, unless command is in `tools.exec_allowlist` |
| `git.commit` | ask |
| `git.push` | always ask |
| `job.submit_result` | workers only |
| `job.spawn_worker` | master only, depth check |

No dynamic tool creator in v1.

### 4.6 Vault

- macOS: Keychain via Electron helper or `security` CLI.
- Linux / VPS: age-encrypted file `~/.hivekit/vault.age` or `HIVEKIT_MASTER_KEY`.
- Web cloud: same vault on the server. Browser never receives raw provider keys.

Clients send `vault.set(provider, key)` over the WS after local pairing. The Gateway writes the vault. Logs print `sk-***`.

## 5. Workspace layout

Default: `~/.hivekit/workspace` (override in YAML).

```
workspace/
  AGENTS.md          # how this hive behaves
  SOUL.md            # tone and boundaries
  USER.md            # who the operator is
  IDENTITY.md        # name, avatar, pronouns for the hive
  TOOLS.md           # local notes on what is wired
  HEARTBEAT.md       # recurring jobs
  inbox/             # drop files here
  jobs/<id>/         # scratch + worker outputs
  out/               # promoted artifacts
  memory/YYYY-MM-DD.md
  skills/            # optional private skills
```

Prompt assembly budget (starting point, tunables in YAML):

| Layer | Budget |
| --- | --- |
| SOUL + IDENTITY | 800 tokens |
| AGENTS + TOOLS | 600 tokens |
| USER | 400 tokens |
| Matched skill | 800 tokens |
| Memory search | 1200 tokens |
| Workspace index | 800 tokens |
| Task spec / chat | remainder |

External documents go in as extracted text wrapped in `<untrusted>` tags.

## 6. Skills

A skill is a folder:

```
skills/tax-dashboard/
  SKILL.md          # when to use, procedure, output contract
  schema.json       # optional JSON schema for the final artifact
```

Matching: master sees a one-line catalog (name + trigger). Full body loads only on match — same idea as OpenClaw / Claude skills.

v1 ships three reference skills: `news-site`, `tax-dashboard`, `file-workshop`.

## 7. Clients

### 7.1 Shared UI kit

One React (or Preact) app in `apps/web`. Electron loads it from disk. Cloud serves it. Android v1 is a Kotlin shell with a WebView for chat + a native job list and approval sheet so push and biometric approve feel native.

### 7.2 Electron macOS

- Traffic-light window, sidebar, optional native menu.
- File drop onto `inbox/`.
- Keychain integration.
- Local preview of `out/**/*.html`.

### 7.3 Android

- Connects to a reachable Gateway (Tailscale recommended).
- Push via FCM for `needs_approval` and `job.done`.
- Artifact preview: Markdown, HTML, images, CSV tables.

### 7.4 Cloud web

- Same UI as Electron.
- Auth: single operator passkey + recovery code.
- No multi-tenant in v1. One compose stack = one operator.

Mock screens: [docs/ui](ui/README.md).

## 8. Security model

1. Pairing: first client to a fresh Gateway becomes owner. Later clients need the owner token.
2. Workspace is not a hard sandbox, but tools refuse paths outside it.
3. `exec.run` is a separate permission bit.
4. Provider keys never round-trip back to clients after write.
5. Anonymous / stealth models get a red banner: "provider retains prompts." Tax skill defaults to blocking those providers unless the operator flips `skills.tax-dashboard.allow_stealth: true`.
6. Budget circuit breaker kills new completions when the job exceeds `budget_usd`.

## 9. Observability

- Structured logs: job_id, task_id, model, tokens_in, tokens_out, usd, latency_ms.
- `hivekit doctor` checks: node version, vault, provider ping, workspace writable, disk.
- Each job writes `jobs/<id>/trace.jsonl`.

## 10. Implementation slice (suggested)

Monorepo, TypeScript, Node 22+:

```
apps/gateway        # the daemon
apps/web            # UI
apps/electron       # thin wrapper
apps/android        # Kotlin shell
packages/protocol   # frame types
packages/models     # adapters
packages/tools      # tool bus
packages/workspace  # markdown + index
```

SQLite via `better-sqlite3` or `libsql`. No second database in v1.

## 11. What "simple setup" means in practice

```
curl -fsSL https://hivekit.dev/install.sh | sh     # later
hivekit init
# editor opens config/hivekit.yaml
hivekit doctor
hivekit gateway
# open http://127.0.0.1:8787
```

Until the installer exists, Docker Compose in `deploy/` is the supported path.

## 12. Evolution valve

If Hivekit ever needs WhatsApp, it should grow an OpenClaw-compatible channel plugin — not invent a second Baileys stack. The protocol and workspace files are already close enough that a future bridge is plausible. Do not build it in v1.
