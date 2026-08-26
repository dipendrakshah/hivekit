# 05 — Hardening + release

Goal: safe to leave running on the public internet, boring to upgrade, documented for a stranger.

## Work

- [ ] Policy modes end-to-end: `ask` (default), `auto` (allowlisted reads only), `strict`; always-ask set enforced in every mode.
- [ ] Prompt-injection hygiene: untrusted wrapper **plus capability reduction** on all fetched content; corpus of ≥30 malicious pages/emails across page text, email bodies, PDF text layers, filenames and delimiter-injection attempts.
- [ ] Secret redaction audit across logs, thread transcripts sent to providers, and error reports.
- [ ] Backup/restore: volume snapshot docs + restore drill onto a second VM.
- [ ] Upgrade path: image tag pinning, migration-on-boot, downgrade note; changelog discipline.
- [ ] `hivekit doctor` extended: provider ping per configured model, connector auth checks, disk, TLS expiry.
- [ ] README quickstart video/GIF + EC2 walkthrough matching PRD §6.1 exactly.
- [ ] v1.0.0 tag: signed release, docker multi-arch (amd64/arm64), demo GIFs from a real hive.

## Definition of done

- [ ] OWASP-style pass: session fixation, CSRF on state-changing routes, WSS origin check all covered by tests.
- [ ] Injection corpus: zero settings changes, zero external sends, **zero tool escalations** from wrapped content. Delimiter injection — a payload containing the delimiter itself — has its own case.
- [ ] Leak suite catches a deliberately introduced leak (verified by mutation), not just the absence of one.
- [ ] A CI job provisions a clean host, follows `deploy/README.md` verbatim, and reaches a healthy hive. If the docs drift, this job fails.
- [ ] Migrations run against a database restored from the previous release, every release.
- [ ] Restore drill: second VM serving the restored volume with full thread/routine/receipt history in ≤ 20 minutes.
- [ ] Stranger test: someone who has never seen the repo completes PRD §12 criteria 1–4 using only README + in-app UI.

Last reviewed: 2026-08-26
