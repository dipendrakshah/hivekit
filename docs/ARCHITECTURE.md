# Hivekit System Architecture

Version: 0.2
Companion to [PRD.md](../PRD.md).
Reference shape: Grok Bot (thread UX, parallel bots, inline approvals, routines) — minus the vendor cloud.

---

## 1. One-sentence architecture

A single **Bun process** serves the web app, speaks WSS to browsers, runs the agent loops, fires routine crons, and talks to connectors — all state in one SQLite file on one volume, deployable by `docker compose up` on any small VM.

### 1.1 Locked stack

Chosen so chat latency ≈ model TTFB — nothing we control adds a visible hop.

| Layer | Pick | Why it is the fast path |
| --- | --- | --- |
| Runtime | **Bun** (Node 22 documented as fallback target, not built twice) | Native WebSocket, built-in SQLite (no FFI), ~40 ms cold start |
| HTTP/WSS | `Bun.serve` raw — no framework on the hot path | ~6 routes; a router adds µs, a framework adds middleware chains |
| Schemas | Zod v4, validated only at the WS frame boundary | Parse once; typed objects internally |
| DB | `bun:sqlite`, WAL, prepared statements, raw SQL, `synchronous=NORMAL` | Sync writes ≈ 100 µs; zero ORM query planning |
| Model calls | Plain `fetch` against OpenAI-compatible `/chat/completions` (Anthropic translated); no vendor SDKs | SDKs add buffering layers and version drift; streaming stays byte-faithful |
| Token relay | Chunks → WS immediately; thread rows flushed every ~250 ms and on finish, never per token | First token = provider TTFB + <5 ms of ours |
| Frontend | Preact + Vite; optimistic local echo; virtualized thread | ~4 KB runtime; instant-send feel regardless of RTT |
| Scheduler | croner, in-process, persisted in SQLite | A Redis/queue hop costs more than cron itself |
| Connectors | `fetch`; shell-out to system git; `imapflow` for IMAP | Zero heavy deps |
| Deploy | oven/bun multi-stage → slim image, Caddy TLS, volume for the `.db` | See [deploy/](../deploy/README.md) |

Per-turn gateway overhead target: **<20 ms p50, <100 ms p99** (PRD NFR-2).

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
| Six workspace persona files (`SOUL.md`, `IDENTITY.md`, …) | **Two** per thread: `INSTRUCTIONS.md` + `MEMORY.md` on the data volume (§4.8). Still file-backed — greppable, diffable, revertable — just two files instead of six, and the Settings editor writes the file rather than a second copy in the DB |
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
Thread      id, slug, title, workspace_path, memory_hash, created_at
            # instructions + memory live on disk; the DB stores where and a hash
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

1. Load thread context + `INSTRUCTIONS.md` + `MEMORY.md` + matched connector notes + recent artifact index (§4.8).
2. Ask the master model for a `Plan` (JSON schema): tasks ≤ 8, each with inputs, expected artifact, success sentence.
3. Spawn workers. Fold each structured `Result` into a synthesis.
4. When tasks settle, ask for `Merge` → final message + artifacts in-thread.
5. Write `MEMORY.md` once, atomically, and post the diff into the thread (§4.8).
6. On failure: walk the FR-A6 ladder; then post a question card instead of guessing.

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

Adapters: `openai_compat` (OpenRouter, Groq, Together, Fireworks, Ollama, LM Studio, custom base URL) and `anthropic`. Google optional later. Both are plain `fetch` against the provider endpoint — no vendor SDKs on the hot path; streaming passes through byte-faithful.

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
`email.fetch` is tagged untrusted at ingest, and the tag travels with the text for provenance
wherever it is quoted or rendered. Capability reduction triggers on **raw untrusted
payloads**: a task whose context contains unmodified fetched text has `site.push`, `x.post`,
`email.send` and `exec.run` **removed from its tool list** — absent, not denied. A reader
worker's *findings* are a different thing: once its result passes schema validation and each
claim carries a citation locator (§4.4.2), it is attested data, and the master — or any actor
task fed only findings — keeps its full tool list. That boundary keeps the two-hop flow
coherent (read raw → return attestations → act on attestations); if the tag simply propagated
through derived artifacts it would eventually revoke everyone. Wrapping untrusted text in
delimiters and telling the model not to obey it remains necessary but insufficient; removal
is what holds against a payload that fully convinces the model.

Every "always ask" action writes an `Approval` receipt — action, diff/payload, deciding human, model used. Receipts are browsable; this is Hivekit's audit answer to the trust gap flagged in Grok Bot coverage.

### 4.6 Scheduler

In-process cron via **croner** (schedule state persisted in SQLite so reboot-safe). Routines are authored in natural language: the master model converts the request into `{cron, prompt_template, connectors, notify}`, shown back as a confirm card before anything persists. Each tick enqueues a synthetic operator message ("[routine] morning-site-update fired") into the routine's thread; missed ticks while down run once on boot, flagged late. Notify policies: `always`, `on-approval-only` (default), `silent-until-done`; outbound pings use email digest via the operator's SMTP.

### 4.7 Vault & auth

- First login sets an owner passkey; sessions are signed cookies; single-operator.
- Secrets (provider keys, X keys, IMAP app password) stored AES-256-GCM, key from `HIVEKIT_MASTER_KEY` env; never sent to clients after save; redacted (`sk-***`) in all logs.
- Stealth/free models show a persistent banner when routed sensitive scopes (e.g., email).

### 4.8 Thread workspace and memory

Each thread is a directory on the data volume:

```
/data/threads/<slug>/
  INSTRUCTIONS.md      operator-written: voice, the bar, the never-list
  MEMORY.md            master-written: state block, learned entries, corrections
  artifacts/           promoted outputs
  jobs/<job-id>/       scratch, worker outputs
```

**Files are the source of truth, not the database.** The Settings instructions editor reads
and writes `INSTRUCTIONS.md`; SQLite holds the path and a content hash so the gateway can
detect an out-of-band edit and reload. Keeping the canonical copy in a markdown file is the
whole point: you can `grep` it, `diff` it, edit it over SSH, and put it in git.

#### `MEMORY.md` shape

````markdown
## State
```json
{ "last_run": "2026-08-26T07:04:11+05:30", "seen": ["src-a#8821", "src-b#441"] }
```

## Learned
- 2026-08-26 — Dropped source `example.dev/feed`: three consecutive sweeps found nothing
  above the bar. Re-add if that changes.
- 2026-08-24 — Their release notes put the breaking change in a footnote; read footnotes
  on that source. (from https://example.dev/notes, verified against the changelog)

## Corrections
- 2026-08-25 — Operator rejected a draft for "revolutionise". No marketing verbs, ever.

## Sources
- https://example.dev/feed — good on protocol changes, noisy on funding
````

The `State` block is machine-maintained and is what makes a routine incremental — a morning
sweep reads `seen` and skips what it already handled. Everything else is prose a human reads.

#### Write discipline

| Rule | Why |
| --- | --- |
| **Only the master writes**, once, at end of job | One writer means no locking, no interleaving, no lost updates |
| Atomic: write temp file, `fsync`, rename | A crash mid-write leaves the previous memory intact, never a half file |
| The write is posted to the thread **as a diff** | You see what your bot decided to remember, where you see everything else |
| Workers never write memory | They are stateless and independently retryable; that is what makes the fan-out safe |
| Capped at `memory.max_bytes` (default 8 KB) | It is paid on every master call. Past the cap, prune superseded entries and say so in the same diff |
| Corrections are pruned last | Operator corrections are the highest-value lines in the file |

#### Memory poisoning — the risk this adds

Giving a durable memory file to an agent that reads the open web and an inbox creates a new
attack: get a sentence into `MEMORY.md` and it is reloaded on every future run, long after the
malicious page is forgotten. Wrapping untrusted content stops it steering *this* job; it does
nothing about persistence.

Four controls, in order of how much they carry:

1. **Memory can never grant capability.** Connectors, the always-ask set, budgets and approval
   requirements are resolved from config and Settings only — never from `MEMORY.md`. A memory
   line saying "the operator approved silent pushes" is inert text. The gateway does not read
   permissions out of prose, so persuading the prose achieves nothing.
2. **Provenance on anything untrusted.** A claim derived from fetched content is written as
   `(from <url>, unverified)`, never as a bare fact. A master reading it later treats it as a
   lead, not as a settled truth.
3. **Every write is a visible diff.** A silent append is how poisoning survives; a diff in the
   thread is how you notice a bot suddenly deciding something strange.
4. **Cheap reversion.** With `memory.git: true` each write is a commit, so
   `hivekit memory log|diff|revert` gives you history and a one-command undo. Without it you
   still have the previous file in the volume backup.

The residual risk is a plausible-looking false fact that the operator does not catch in the
diff. That is real, and it is why memory is capped and prose-only: a small file gets read.

#### Git-backing

`memory.git: true` makes `/data/threads` a git repository and commits after each memory write
(`thread/<slug>: memory after job_21a`). This gives history, blame, diff and revert for free,
and lets you clone your bots' memory to a laptop to edit it properly. Off by default because
it needs `git` in the image and a little disk; on is the better setting once you have more
than one thread.

## 5. Repository layout

```
apps/gateway        # Bun daemon: HTTP+WSS (Bun.serve), agents, scheduler, serves apps/web build
apps/web            # responsive UI (Preact + Vite), desktop + mobile layouts
packages/protocol   # frame + schema types (zod)
packages/models     # adapters + catalog cache
packages/tools      # tool bus + policies
packages/connectors # site(git) · x(X API) · email(IMAP/SMTP)
deploy/             # docker-compose.yml, Dockerfile, Caddyfile, EC2 / Fly / Cloudflare guides
```

SQLite via `bun:sqlite`: WAL mode, prepared statements, raw SQL (`synchronous=NORMAL`), no ORM. Backups = copy the volume.

## 6. Security model summary

1. Owner passkey → session cookie → WSS auth. No multi-tenant anything.
2. Tools refuse paths outside the data dir. No dynamic tool creation.
3. External sends (push/tweet/email) are structurally unable to bypass approval cards.
4. Untrusted content is wrapped **and reduces capability** — a task holding raw fetched text cannot see the external-send tools at all; attested findings do not trigger revocation (§4.5). Wrapping alone is not a control.
5. Budget circuit breaker stops new completions past `limits.budget_usd_per_job`.
6. Every irreversible action leaves a receipt.
7. **Memory is data, never permission.** `MEMORY.md` is reloaded every run but cannot grant a
   connector, waive an approval, or raise a budget — those resolve from config and Settings
   only (§4.8). Memory writes are diffed into the thread and, with `memory.git`, revertable.

## 7. Setup, in practice

```sh
git clone && cp .env.example .env   # HIVEKIT_TOKEN, HIVEKIT_MASTER_KEY, PUBLIC_URL
docker compose up -d                # Caddy + hivekit + volume
open https://hive.example.com       # set passkey → paste key → message the hive
hivekit doctor                      # container exec: config, vault, provider ping, disk
```

## 8. Evolution valve

A fourth connector (LinkedIn, Telegram listener, etc.) must arrive as a new module in `packages/connectors` with its own approval kinds — not as core changes. If multi-user ever matters, fork into a v2 PRD; do not grow IAM quietly.
