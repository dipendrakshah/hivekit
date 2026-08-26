# 08 — Cloud web app

## What to do

Same UI, remote Gateway, operator-hosted.

Work:

1. Compose: Caddy (TLS) + Gateway + volume.
2. Passkey (or magic-link if passkey slips) for the single operator.
3. `gateway.expose: true` behind Caddy, never raw 8787 on 0.0.0.0 without token.
4. Fly.io or Railway example in `deploy/`.
5. Backup note: volume contains workspace + sqlite + vault.

## Definition of done

- [ ] Fresh VPS or local compose: open the printed URL, log in, run the PDF briefing sample.
- [ ] Hitting the Gateway port without the client token fails.
- [ ] Browser never receives provider API keys in any network response (devtools check recorded).
- [ ] Restart of the container restores jobs that were `done` and does not restore in-flight workers as zombies (they mark failed/cancelled).
- [ ] Mock parity vs `docs/ui/web-cloud.html`.
