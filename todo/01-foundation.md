# 01 — Foundation (deployable box)

Goal: `docker compose up` on a fresh VM yields an authenticated Hivekit that can hold a trivial conversation. No agents yet.

## Work

- [ ] Monorepo scaffold: `apps/gateway`, `apps/web`, `packages/{protocol,models,tools,connectors}`; TypeScript, Node 22+.
- [ ] Config loader for `config/hivekit.example.yaml` shape + env overrides (`HIVEKIT_TOKEN`, `HIVEKIT_MASTER_KEY`, `PUBLIC_URL`).
- [ ] SQLite (better-sqlite3, WAL) with migrations for: threads, messages, jobs, tasks, routines, approvals, settings, vault.
- [ ] Vault: AES-256-GCM encrypt/decrypt keyed by `HIVEKIT_MASTER_KEY`; redaction helper (`sk-***`) applied to all log paths.
- [ ] HTTP server serving static UI build + WSS at `/ws`; frame protocol `req.hello` / `req.chat.send` / events per ARCHITECTURE §4.1.
- [ ] Auth: first-login owner passkey, signed session cookies, single operator.
- [ ] `deploy/docker-compose.yml` + Caddyfile + `.env.example`.
- [ ] Deploy guides: EC2 (Lightsail/t4g.nano), Fly/Railway volume note, Cloudflare DNS/Tunnel pattern.
- [ ] `hivekit doctor` exec command: config parse, DB writable, disk, TLS reachable.

## Definition of done

- [ ] Fresh Ubuntu 24.04 VM: clone → compose up → open HTTPS URL → set passkey → send message → receive echoed reply in < 15 min total.
- [ ] Second browser (phone) logs in with passkey and sees the same thread.
- [ ] Kill -9 the container mid-conversation; restart; history intact.
- [ ] `doctor` exits 0 on healthy stack and names the broken check when a var is unset.

Last reviewed: 2026-08-26
