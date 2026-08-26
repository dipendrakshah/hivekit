# 05 — Hardening + release

Goal: safe to leave running on the public internet, boring to upgrade, documented for a stranger.

## Work

- [ ] Policy modes end-to-end: `ask` (default), `auto` (allowlisted reads only), `strict`; always-ask set enforced in every mode.
- [ ] Prompt-injection hygiene: untrusted wrapper on all fetched content; test corpus of malicious pages/emails that must not flip settings or trigger sends.
- [ ] Secret redaction audit across logs, thread transcripts sent to providers, and error reports.
- [ ] Backup/restore: volume snapshot docs + restore drill onto a second VM.
- [ ] Upgrade path: image tag pinning, migration-on-boot, downgrade note; changelog discipline.
- [ ] `hivekit doctor` extended: provider ping per configured model, connector auth checks, disk, TLS expiry.
- [ ] README quickstart video/GIF + EC2 walkthrough matching PRD §6.1 exactly.
- [ ] v1.0.0 tag: signed release, docker multi-arch (amd64/arm64), demo GIFs from a real hive.

## Definition of done

- [ ] OWASP-style pass: session fixation, CSRF on state-changing routes, WSS origin check all covered by tests.
- [ ] Injection corpus: zero settings changes or external sends triggered from wrapped content.
- [ ] Restore drill: second VM serving the restored volume with full thread/routine/receipt history in ≤ 20 minutes.
- [ ] Stranger test: someone who has never seen the repo completes PRD §12 criteria 1–4 using only README + in-app UI.

Last reviewed: 2026-08-26
