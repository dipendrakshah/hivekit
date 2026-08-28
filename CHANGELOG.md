# Changelog

## 1.0.0 (2026-08-27)

First tagged release. Streams 01–06 complete.

- Gateway: Bun.serve raw, WS frame protocol, Argon2id passkey auth, AES-256-GCM
  vault, run-journal crash safety, token relay (first token = provider TTFB + <5ms)
- Memory: four-tier MEMORY.md, typed write path with five guards, retrieval
  (prompt-size flat in memory size), decay, ledger, git backing, operator CLI
- Models: openai_compat + anthropic adapters (plain fetch, no SDKs), capability
  probe with TTL, per-capability rendering (G9: weak models complete real jobs),
  FR-A6 validation ladder, spend log (requested vs served)
- Connectors: SSRF-guarded web.fetch/rss.read, site (git, approval-gated push),
  x (OAuth1.0a), email (dependency-free SMTP + imapflow poller)
- Routines: cron with TZ, catch-up-once-late, preflight gates, incremental
  content-hash runs, notify policies
- Web app: responsive shell, approval sheets (deny-first, idempotent), receipts,
  PWA manifest, snapshot-replace reconnect
- Security: policy modes (ask/auto/strict, always-ask floor), 34-payload
  injection corpus, memory-poisoning defences, 200-run pollution soak,
  OWASP pass (session fixation, CSRF, WSS origin), redaction audit incl. memory
