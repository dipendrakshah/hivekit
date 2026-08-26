# 01 — Foundation (deployable box)

Goal: `docker compose up` on a fresh VM yields an authenticated Hivekit that can hold a trivial conversation. No agents yet.

## Work

- [ ] Monorepo scaffold: `apps/gateway`, `apps/web`, `packages/{protocol,models,tools,connectors}`; TypeScript on **Bun** (Node 22 documented as fallback target, not built twice).
- [ ] `Bun.serve` raw for HTTP+WSS (~6 routes, no framework); Zod validation only at the WS frame boundary.
- [ ] SQLite via `bun:sqlite` (WAL, prepared statements, raw SQL, `synchronous=NORMAL`) with migrations for: threads, messages, jobs, tasks, routines, approvals, settings, vault.
- [ ] Token relay: stream chunks to WS immediately; flush message rows every ~250 ms and on completion — never per token.
- [ ] Config loader for `config/hivekit.example.yaml` shape + env overrides (`HIVEKIT_TOKEN`, `HIVEKIT_MASTER_KEY`, `PUBLIC_URL`).
- [ ] Vault: AES-256-GCM encrypt/decrypt keyed by `HIVEKIT_MASTER_KEY`; redaction helper (`sk-***`) applied to all log paths.
- [ ] HTTP server serving static UI build + WSS at `/ws`; frame protocol `req.hello` / `req.chat.send` / events per ARCHITECTURE §4.1.
- [ ] Auth: first-login owner passphrase ("passkey"), hashed with Argon2id via `Bun.password` — never WebAuthn in v1 (see ARCHITECTURE §4.7); signed session cookies; single operator.
- [ ] `deploy/docker-compose.yml` + Caddyfile + `.env.example`.
- [ ] Deploy guides: EC2 (Lightsail/t4g.nano), Fly/Railway volume note, Cloudflare DNS/Tunnel pattern.
- [ ] `hivekit doctor` exec command: config parse, DB writable, disk, TLS reachable.

- [ ] Run journal: every job/task transition persisted before side effects; state is a fold over it, so a `SIGKILL` mid-job resumes exactly.
- [ ] Vault: AES-GCM column, key from `HIVEKIT_MASTER_KEY`; a missing key is a clear startup error, never a silent plaintext fallback.
- [ ] Redaction at the serialisation boundary — the writer holds the active secret set — not a regex over finished strings.
- [ ] `deploy/` builds and runs: Dockerfile, compose, Caddyfile.
Memory (§4.8) was split into its own stream: see [02-memory.md](02-memory.md).

## Definition of done

- [ ] Fresh Ubuntu 24.04 VM: clone → compose up → open HTTPS URL → set passkey → send message → receive echoed reply in < 15 min total.
- [ ] Second browser (phone) logs in with passkey and sees the same thread.
- [ ] Kill -9 the container mid-conversation; restart; history intact.
- [ ] `doctor` exits 0 on healthy stack and names the broken check when a var is unset.

- [ ] `SIGKILL` mid-job then restart reproduces the exact job state — an actual kill, not a graceful shutdown.
- [ ] Leak suite: synthetic keys of every provider shape **plus a custom shape**, at every nesting depth including inside `Error.cause`, never appear in logs, thread transcripts, WS frames or error reports. Runs on every PR.
- [ ] `docker compose -f deploy/docker-compose.yml up -d` reaches a healthy container on a clean machine, verified by CI.
- [ ] Loopback latency probe: a chat turn's gateway overhead (frame in → first chunk relayed) measures <20 ms p50 / <100 ms p99 over the provider stream, logged per request.

Last reviewed: 2026-08-26
