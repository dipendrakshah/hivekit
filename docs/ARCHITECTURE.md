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
  MEMORY.md            the active memory — tiered, typed, human-readable
  memory/
    candidates.jsonl   observations not yet promoted   (never enters a prompt)
    archive.jsonl      superseded and retired entries  (never enters a prompt)
    ledger.jsonl       per-entry usage and outcomes    (never enters a prompt)
  artifacts/           promoted outputs
  jobs/<job-id>/       scratch, worker outputs
```

**Files are the source of truth, not the database.** The Settings instructions editor reads
and writes `INSTRUCTIONS.md`; SQLite holds paths and content hashes so the gateway can detect
an out-of-band edit and reload. Keeping the canonical copy in markdown is the point: you can
`grep` it, `diff` it, edit it over SSH, and put it in git.

#### 4.8.1 Why memory needs structure

Free-form append-only memory degrades an agent. Not through attack — through ordinary use.
Ten failure modes, all observed in practice, and what the design does about each:

| Failure | What it looks like | Control |
| --- | --- | --- |
| **Dilution** | 40 lines loaded every call; the 3 that matter are lost in the noise, and cost rises every run | **Retrieve, don't load** (§4.8.3) |
| **Staleness** | "example.dev is a good source" — true in March, false since | **TTL on facts**, sources revalidated |
| **Contradiction** | Two active entries disagree; the model picks one non-deterministically | **Supersede-by-id**; a conflict check gates the write |
| **Over-generalisation** | One rejected draft becomes "never use adjectives" | **Candidate → rule promotion** (§4.8.4) |
| **Drift** | Each run re-summarises the last; meaning shifts, telephone-game | **Entries are immutable**; you supersede, never edit |
| **Unfalsifiable** | "The operator prefers concise writing" — can never be checked, so never retired | Every rule needs a **`when`** and a **`wrong-if`** |
| **Duplication** | The same lesson relearned five times in five phrasings | **Dedupe on write** against active entries |
| **Scope leak** | A lesson about one source applied to every source | Every entry carries a **scope**; retrieval matches it |
| **Self-confirmation** | Memory says do X → agent does X → records "X worked" → reinforces | **Hold-out audits** (§4.8.6) |
| **Recency swamping** | Newest entries crowd out durable truths, which look stale and get pruned first | **Tiered budgets**; eviction by evidence, not age |

The through-line: **an entry earns its place in the prompt, and keeps earning it.** Writing
something down is not the same as it being true, and being true once is not the same as being
worth 200 tokens on every call forever.

#### 4.8.2 Tiers

`MEMORY.md` holds only what is **active**. Four tiers with different rules:

````markdown
## Pinned
<!-- operator corrections. authoritative on write, never auto-edited, never auto-retired -->
- [p1] No marketing verbs, ever.  ·op 2026-08-25

## Rules
<!-- promoted from candidates. scoped, falsifiable, evidence-tracked -->
- [r7] Read footnotes on example.dev — breaking changes hide there, not in the body.
       ·when source=example.dev  ·wrong-if a breaking change appears in the body only
       ·confirmed 3/3  ·used 12  ·last 2026-08-26

## Facts
<!-- expire by default; provenance mandatory when derived from untrusted content -->
- [f2] example.dev publishes roughly twice a week.
       ·derived (from https://example.dev/feed, unverified)  ·expires 2026-11-01

## State
```json
{ "last_run": "2026-08-26T07:04:11+05:30", "seen": ["src-a#8821"] }
```
````

| Tier | Written by | Enters the prompt | Evicted when |
| --- | --- | --- | --- |
| **Pinned** | operator only | always, in full | only the operator removes it |
| **Rules** | master, after promotion | top-K by scope match | `wrong-if` fires, or unused for `retire_unused_after` runs |
| **Facts** | master | scope-matched, unexpired, top-N | TTL expires, or superseded |
| **State** | master, machine-maintained | always, as JSON | keys the master no longer maintains |

Pinned is the only tier the operator writes and the only one that never expires, because an
operator correction is ground truth and everything else is inference. It is also the smallest,
which is why it can afford to always load.

#### 4.8.3 Retrieval, not wholesale loading

The single biggest lever against dilution and cost: **memory size is decoupled from prompt
size.** A thread with 400 remembered entries and one with 12 produce the same prompt budget.

```
assemble(job):
  pinned   → all of it                                    (cap: memory.pinned_max)
  state    → the JSON block                               (compact, always)
  rules    → scope-match(job) → rank(confirmations, recency of use) → top K
  facts    → scope-match(job) → drop expired → top N
```

Scope is matched on what the job actually touches: connector, source domain, artifact kind,
routine name. A rule scoped `source=example.dev` does not enter a job about the inbox.
Anything retrieved is recorded in `ledger.jsonl` against the entry — which is what makes
retirement evidence-based rather than guesswork.

#### 4.8.4 Promotion: one observation is not a rule

The control for over-generalisation, and the most important thing here after retrieval.

```
master notices something
        │
        ▼
 candidates.jsonl        one line, never enters a prompt
        │
        │  same observation, independently, in N distinct jobs
        │  (memory.promote_after, default 3)
        ▼
   Rules in MEMORY.md    now retrievable, now costs tokens
```

- A single observation is a **candidate**. It is logged and it does nothing.
- Promotion needs `promote_after` independent confirmations from **distinct jobs** — not three
  restatements inside one run, which is a model agreeing with itself.
- Promotion is announced in the thread: *"promoted r7 after a third confirmation"*.
- **Operator corrections skip all of this.** They go straight to Pinned. A person saying
  "stop doing that" is not a hypothesis awaiting evidence.

A rule must carry a **`when`** (the scope that triggers it) and a **`wrong-if`** (what would
show it false). If the master cannot write a `wrong-if`, the observation is not a rule — it is
a preference, and preferences belong in `INSTRUCTIONS.md` where a human owns them.

#### 4.8.5 Write path

One write per job, by the master, as an atomic replace:

```
1. Draft the change as a set of typed operations, never free text:
     add-candidate | promote | supersede(id) | retire(id) | update-state
2. Reject the write if it would:
     - add an entry contradicting an active one without an explicit supersede(id)
     - add a near-duplicate of an active entry
     - add a Rule with no `when` or no `wrong-if`
     - add a Fact with no TTL and no provenance
     - edit or delete a Pinned entry
3. Apply: MEMORY.md rewritten atomically (temp → fsync → rename);
          superseded entries appended to archive.jsonl with their original text
4. Post the diff into the thread
```

Entries are **immutable**. A changed belief is a `supersede(id)` — a new entry plus the old one
archived with its original wording — never an edit in place. That is what stops the
telephone-game drift where a rule slowly becomes something nobody wrote.

Workers never read or write memory. They are stateless, which is what makes the fan-out
independently retryable.

#### 4.8.6 Proving memory is worth having

Self-confirmation is the failure nothing above catches: memory says do X, so the agent does X,
so it records that X worked. The only honest check is a counterfactual.

Every `memory.audit_every` runs (default 20), the thread runs one job **with retrieval
disabled** and compares against the memory-on result: approval rate, operator edits before
approval, retries, cost. The result is reported in the thread and written to `ledger.jsonl`.

If memory-off does as well or better, the UI says so plainly rather than burying it. A memory
that is not earning its tokens should be pruned or turned off, and you cannot know which
without measuring.

Per-entry, the ledger gives the same signal at finer grain: an entry retrieved 40 times whose
jobs are no better than jobs without it is a candidate for retirement.

#### 4.8.7 Memory poisoning — the adversarial case

Distinct from pollution, rarer, worse when it lands. A thread reading the open web or an inbox
can be told to write a durable sentence: get it into memory once and it reloads on every
future run, long after the page is forgotten. Wrapping untrusted content stops it steering
*this* job and does nothing about persistence.

1. **Memory can never grant capability.** Connectors, the always-ask set, budgets and approval
   requirements resolve from config and Settings only — never from `MEMORY.md`. A memory line
   saying "the operator approved silent pushes" is inert: the gateway does not read permissions
   out of prose, so persuading the prose achieves nothing.
2. **Untrusted-derived content cannot become a Rule.** It can only be a Fact, with provenance
   and a TTL. Rules are behavioural; facts are disposable. An injected sentence therefore
   expires on its own even if nobody notices it.
3. **Promotion needs independent confirmation** (§4.8.4), so a single poisoned page cannot
   install a rule at all.
4. **Every write is a visible diff**, and promotions are announced.
5. **Cheap reversion** — with `memory.git`, `hivekit memory log|diff|revert`.

Residual risk: a plausible false Fact that survives its TTL by being re-observed. Bounded, and
bounded is the honest claim — it cannot change behaviour by itself, only inform it.

#### 4.8.8 Operator controls

Memory is only trustworthy if the person who owns it can see and steer it.

| Command | Does |
| --- | --- |
| `hivekit memory show [--tier]` | Render active memory |
| `hivekit memory why <id>` | Provenance, confirmations, which jobs used it, what it changed |
| `hivekit memory pin <id>` | Promote to Pinned — you vouch for it |
| `hivekit memory retire <id>` | Archive it, with a reason |
| `hivekit memory candidates` | What is waiting for evidence |
| `hivekit memory audit` | Run the hold-out comparison now |
| `hivekit memory log \| diff \| revert` | Git history, when `memory.git` is on |

`why` matters most. "Why does my bot believe this?" should be one command, and the answer
should name the jobs, not a vibe.

#### 4.8.9 Git-backing

`memory.git: true` makes `/data/threads` a git repository and commits after each write
(`thread/<slug>: memory after job_21a`). History, blame, diff and revert for free, and you can
clone your bots' memory to a laptop to edit it properly. Off by default because it needs `git`
in the image and a little disk; on is the better setting once you have more than one thread.

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
