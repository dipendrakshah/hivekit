# 03 — Connectors + routines

Goal: the three v1 connectors work end to end, and recurring jobs run unattended with approvals waiting in-thread.

## Work

- [ ] Tool bus + policy gate per ARCHITECTURE §4.5 (allow / ask / always-ask), wired to approval cards.
- [ ] `web.fetch` / `rss.read`: parallel fetch tool, content wrapped as untrusted.
- [ ] `site` connector: clone once, branch per job, commit drafts; `site.push` = always-ask card with diff preview; receipt stored on decision.
- [ ] `x` connector: `x.draft` (allow) + `x.post` via X API v2 (always-ask); credentials in vault; tier-limit note in Settings.
- [ ] `email` connector: IMAP poll (app password), triage/digest generation, draft replies; `email.send` via SMTP = always-ask. Stealth providers blocked for this scope by default.
- [ ] Approval receipts: every irreversible action persisted with payload/diff, deciding human, model, timestamp; browsable in Receipts tab.
- [ ] Scheduler: cron routines persisted in SQLite, reboot-safe; missed runs catch up once flagged late; notify policies (`always`, `on-approval-only`, `silent-until-done`).
- [ ] Routine CRUD from thread ("every morning at 07:00 …") and Routines tab; pause/resume/edit without losing history.

## Definition of done

- [ ] Website routine fires overnight unattended; morning state = diff awaiting approval in-thread; approve → real commit pushed to a test repo; deny → clean abort with receipt.
- [ ] Tweet flow from phone: master drafts 3 variants → tap one → approval → post lands on X test account.
- [ ] Inbox sweep produces morning digest; urgent sender pinned; drafted reply sends only after approval.
- [ ] VM reboot mid-routine: catch-up run executes once and is labeled late.
- [ ] All three connectors show green in `hivekit doctor`.

Last reviewed: 2026-08-26
