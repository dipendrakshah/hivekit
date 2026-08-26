# Hivekit System Architecture

Version: 0.2
Companion to [PRD.md](../PRD.md).
Reference shape: Grok Bot (thread UX, parallel bots, inline approvals, routines) — minus the vendor cloud.

---

## 1. One-sentence architecture

A single **Node process** serves the web app, speaks WSS to browsers, runs the agent loops, fires routine crons, and talks to connectors — all state in one SQLite file on one volume, deployable by `docker compose up` on any small VM.

```
 Operator (desktop or phone browser)
        │  HTTPS / WSS   (Caddy auto-TLS, or Cloudflare DNS/Tunnel in front)
        ▼
┌─────────────────────────────────────────────────────────┐
│ Hivekit container (EC2 / Hetzner / Fly / Railway VM)    │
│                                                         │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ HTTP + WSS │  │ Agent runtime│  │ Scheduler       │  │
│  │ static UI  │  │ master loop  │  │ routines (cron) │  │
│  │ sessions   │  │ worker pool  │  │ catch-up runner │  │
│  └─────┬──────┘  └──────┬───────┘  └────────┬────────┘  │
│        │                │                   │           │
│  ┌─────▼────────────────▼───────────────────▼────────┐  │
│  │ SQLite (WAL): threads, jobs, routines, receipts,  │  │
│  │ spend log, settings, vault (AES-GCM encrypted)    │  │
│  └─────┬────────────────┬───────────────────┬────────┘  │
│        │                │                   │           │
│   Model adapter      Tool bus          Connectors       │
│   (OpenAI-compat,    (fetch, fs under  site(git) · x    │
│    anthropic)         data dir)         (X API) · email  │
└────────┼────────────────┼───────────────────┼───────────┘
         ▼                ▼                   ▼
  OpenRouter / Anthropic /   Web, RSS     git remote · X API ·
  Groq / Ollama / custom                  IMAP / SMTP
```

## 2. What was deleted from the v0.1 design (and why)

The earlier design pack carried OpenClaw-flavored weight. v0.2 keeps the Grok-Bot shape and deletes:

| Removed | Replacement |
| --- | --- |
| Electron macOS app + Android app + cloud web (three surfaces) | One responsive web app served by the Gateway itself |
| Six workspace persona files (`SOUL.md`, `IDENTITY.md`, …) | Bot instructions field in Settings (stored in DB), seeded with a good default |
| Skills folders + marketplace ideas | Routines + per-thread instructions |
| Heartbeat file | Cron scheduler in-process |
| Keychain/age vault per device | Server-side AES-GCM column in SQLite; key from env `HIVEKIT_MASTER_KEY` |

## 3. Deploy shapes

1. **VM + Compose (recommended).** EC2 Lightsail / t4g.nano, Hetzner CX22, DO droplet. Compose stack: Caddy (TLS) + hivekit + volume.
2. **Fly.io / Railway.** One service + attached volume; their TLS terminates WSS fine.
3. **Cloudflare.** No general-purpose VM exists there; the supported pattern is Cloudflare DNS proxy or Tunnel in front of a VM running Hivekit. Workers cannot host long-lived WebSocket gateways.

Sizing: 1 vCPU / 1 GB RAM is enough for ≤ 8 concurrent workers because workers are I/O-bound API calls, not local inference.

## 4. Process internals

### 4.1 Control plane

One port (default `8787`). Static UI at `/`, JSON frames over WS at `/ws`.

Frame types (complete list):

- `req.hello` → snapshot (threads, routines, active jobs, models)
- `req.chat.send` → operator message into a thread
- `req.job.approve` / `req.job.deny` / `req.job.cancel`
- `req.routine.create` / `.pause` / `.resume` / `.edit`
- `req.models.set` (master / worker / reviewer, hot reload)
- `req.connector.set` credentials (writes to vault; never echoed back)
- `event.thread` (messages, cards, artifacts)
- `event.job` (plan/task/worker state transitions)
- `event.approve` (approval card needing a human)

Idempotency keys on `job.approve`, `job.cancel`, `routine.create`.

### 4.2 Data model

```
Thread      id, title, created_at
Message     id, thread_id, role(op|master|worker|system), body, card_json, artifact_refs
Job         id, thread_id, title, status, master_model, worker_model,
            budget_usd, tokens_in/out, usd, created_at, finished_at
Task        id, job_id, idx, title, spec_json, status, model_id, artifacts_json, error
Routine     id, name, cron, prompt_template, connector_scope, notify_policy,
            enabled, last_run_at, next_run_at
Approval    id, job_id, action_kind(site_push|x_post|email_send|exec|delete),
            payload_json, receipt(status, decided_by, decided_at, model, diff_ref)
Setting     key, value            # models, policy, connector configs
Vault       ref, ciphertext       # provider + connector secrets
```

Job states: `planning → running → needs_approval → merging → done | failed | cancelled`.
Crash safety: every transition persists before side effects; boot re-enqueues running tasks and marks interrupted approvals back to `needs_approval`.

### 4.3 Agent runtime

Two loops, one codebase.

**Master loop**

1. Load thread context + bot instructions + matched connector notes + recent artifact index.
2. Ask the master model for a `Plan` (JSON schema): tasks ≤ 8, each with inputs, expected artifact, success sentence.
3. Spawn workers. Fold each structured `Result` into a synthesis.
4. When tasks settle, ask for `Merge` → final message + artifacts in-thread.
5. On failure: retry that task once with a tighter spec; then post a question card instead of guessing.

**Worker loop**

1. Fresh isolated session: task spec + only referenced inputs. No other workers' transcripts,
   no thread history, **no credentials** — connector secrets are dereferenced inside the tool
   executor, outside the model's view.
2. Tool loop until `submit_result`, a cap of 8 tool calls, or timeout.
3. Loop guard: the same tool called twice with the same arguments returns "you already did
   that" instead of the result. Small models loop; catching it in code is cheaper than
   catching it on the invoice.
4. Structured result posted to the job graph; worker session archived.

Workers never see operator chat beyond their task spec. Masters write specs weak models can follow: explicit paths, explicit output format, explicit "do not" list.

### 4.4 Model adapter

```
complete({ model, messages, tools, json_schema?, timeout_ms, max_tokens })
  -> stream | object
```

Adapters: `openai_compat` (OpenRouter, Groq, Together, Fireworks, Ollama, LM Studio, custom base URL) and `anthropic`. Google optional later.

Every call carries `{thread_id, job_id, task_id}`. It is a required field, so there is no code
path that calls a model unattributed — which is why the spend log is complete rather than
approximate.

Catalog cache: on first use of a provider exposing `/models`, store id/context/price/modality; the Settings picker reads it; raw slugs always allowed. Hot swap: changing `models.worker` affects only newly spawned workers.

### 4.4.1 Making weak models usable

The single most important behaviour in the codebase, and the reason a free model can hold a
worker seat at all.

Capabilities come from the provider catalog where published and otherwise from a six-call
probe (~2k tokens) run once per model and cached: echo, system-role adherence, tool call,
JSON schema, long-input needle, instruction discipline.

The same logical request is then rendered per model:

| If the model has | The gateway does |
| --- | --- |
| Native tool calling | Uses it |
| No native tool calling | Describes tools in the prompt; the model emits `<hk:call tool="…">{…}</hk:call>`; the gateway parses it |
| JSON schema mode | Passes the schema — and validates anyway, because providers get this wrong |
| No JSON mode | Inlines the schema with one worked example, validates, repairs |
| No system role | Prepends to the first user message |
| A small context | The master gives it fewer inputs — one document per worker, not the folder |

Parsing is deliberately forgiving: the block is accepted anywhere in the reply, prose around
it is tolerated, fenced variants are accepted, and trailing commas, single quotes, unquoted
keys and smart quotes are repaired. Every repair is counted against that model, so Settings
can show which of *your* models is actually reliable on *your* work — worth more than any
benchmark.

### 4.4.2 Verification order

**Code verifies; a model judges only what code cannot.** In strict cost order:

1. Transport — did the call succeed, is the output non-empty.
2. Shape — does it parse; JSON schema validation.
3. Success test — the plan's `success` sentence, evaluated as a check where it is mechanical:
   file exists, field non-null, number in range, cited span actually contains the quoted text.
4. Reviewer model — only for what code cannot judge (faithfulness, tone), and **only on a
   different model from the one under review**. A model reviewing itself agrees with itself.

Failures walk the ladder in PRD FR-A6: same model with the exact validator error, then a
tighter spec, then the fallback model, then a question card. The error text is the whole
value of the retry.

### 4.4.3 Spend log

A row per call with the model **requested** and the model **actually served** — gateways
substitute, and an unattributed substitution makes cost analysis quietly wrong. Prices are
snapshotted per row so a later price change does not rewrite history. When a provider returns
no usage numbers the gateway estimates locally and flags the row `estimated` rather than
blending a guess into a measurement.

### 4.5 Tool bus

| Tool | Default policy (`ask` mode) |
| --- | --- |
| `web.fetch` / `rss.read` | allow; content wrapped untrusted |
| `fs.read/write/edit` (under data dir only) | allow under `jobs/`, ask elsewhere |
| `site.commit` (local branch) | allow |
| `site.push` | **always ask**, diff preview attached |
| `x.draft` | allow |
| `x.post` | **always ask** |
| `email.fetch` (IMAP) | allow |
| `email.send` (SMTP) | **always ask** |
| `exec.run` | ask unless allowlisted |

**Untrusted content reduces capability.** Anything from `web.fetch`, `rss.read` or
`email.fetch` is tagged untrusted at ingest and the tag follows it into every prompt and
derived artifact. A task whose context holds untrusted content has `site.push`, `x.post`,
`email.send` and `exec.run` **removed from its tool list** — absent, not denied. So web-facing
work is two hops: a reader worker returns structured findings with no ability to act, and the
master acts on findings rather than on raw page text. Wrapping untrusted text in delimiters
and telling the model not to obey it is necessary and not sufficient; this is the part that
holds against a payload that fully convinces the model.

Every "always ask" action writes an `Approval` receipt — action, diff/payload, deciding human, model used. Receipts are browsable; this is Hivekit's audit answer to the trust gap flagged in Grok Bot coverage.

### 4.6 Scheduler

In-process cron (node-cron semantics persisted in SQLite so reboot-safe). Routines are authored in natural language: the master model converts the request into `{cron, prompt_template, connectors, notify}`, shown back as a confirm card before anything persists. Each tick enqueues a synthetic operator message ("[routine] morning-site-update fired") into the routine's thread; missed ticks while down run once on boot, flagged late. Notify policies: `always`, `on-approval-only` (default), `silent-until-done`; outbound pings use email digest via the operator's SMTP.

### 4.7 Vault & auth

- First login sets an owner passkey; sessions are signed cookies; single-operator.
- Secrets (provider keys, X keys, IMAP app password) stored AES-256-GCM, key from `HIVEKIT_MASTER_KEY` env; never sent to clients after save; redacted (`sk-***`) in all logs.
- Stealth/free models show a persistent banner when routed sensitive scopes (e.g., email).

## 5. Repository layout

```
apps/gateway        # Node daemon: HTTP+WSS, agents, scheduler, serves apps/web build
apps/web            # responsive UI (Preact/React), desktop + mobile layouts
packages/protocol   # frame + schema types (zod)
packages/models     # adapters + catalog cache
packages/tools      # tool bus + policies
packages/connectors # site(git) · x(X API) · email(IMAP/SMTP)
deploy/             # docker-compose.yml, Dockerfile, Caddyfile, EC2 / Fly / Cloudflare guides
```

SQLite via `better-sqlite3`, WAL mode. Backups = copy the volume.

## 6. Security model summary

1. Owner passkey → session cookie → WSS auth. No multi-tenant anything.
2. Tools refuse paths outside the data dir. No dynamic tool creation.
3. External sends (push/tweet/email) are structurally unable to bypass approval cards.
4. Untrusted content is wrapped **and reduces capability** — a task holding it cannot see the external-send tools at all (§4.5). Wrapping alone is not a control.
5. Budget circuit breaker stops new completions past `limits.budget_usd_per_job`.
6. Every irreversible action leaves a receipt.

## 7. Setup, in practice

```sh
git clone && cp .env.example .env   # HIVEKIT_TOKEN, HIVEKIT_MASTER_KEY, PUBLIC_URL
docker compose up -d                # Caddy + hivekit + volume
open https://hive.example.com       # set passkey → paste key → message the hive
hivekit doctor                      # container exec: config, vault, provider ping, disk
```

## 8. Evolution valve

A fourth connector (LinkedIn, Telegram listener, etc.) must arrive as a new module in `packages/connectors` with its own approval kinds — not as core changes. If multi-user ever matters, fork into a v2 PRD; do not grow IAM quietly.
