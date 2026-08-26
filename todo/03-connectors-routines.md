# 03 — Connectors + routines

Goal: the three v1 connectors work end to end, and recurring jobs run unattended with approvals waiting in-thread.

## Work

- [ ] Tool bus + policy gate per ARCHITECTURE §4.5 (allow / ask / always-ask), wired to approval cards.
- [ ] `web.fetch` / `rss.read`: parallel fetch tool, content tagged untrusted at ingest with the tag following into every prompt and derived artifact.
- [ ] Untrusted capability reduction: a task holding untrusted content has `site.push`, `x.post`, `email.send`, `exec.run` **removed from its tool list**, and the two-hop reader/actor split for web-facing routines.
- [ ] SSRF guards on `web.fetch`: private ranges, link-local, cloud metadata endpoints, redirect limit, size cap.
- [ ] `site` connector: clone once, branch per job, commit drafts; `site.push` = always-ask card with diff preview; receipt stored on decision.
- [ ] `x` connector: `x.draft` (allow) + `x.post` via X API v2 (always-ask); credentials in vault; tier-limit note in Settings.
- [ ] `email` connector: IMAP poll (app password), triage/digest generation, draft replies; `email.send` via SMTP = always-ask. Stealth providers blocked for this scope by default.
- [ ] Approval receipts: every irreversible action persisted with payload/diff, deciding human, model, timestamp; browsable in Receipts tab.
- [ ] Scheduler: cron routines persisted in SQLite, reboot-safe; missed runs catch up once flagged late; notify policies (`always`, `on-approval-only`, `silent-until-done`).
- [ ] Routine CRUD from thread ("every morning at 07:00 …") and Routines tab; pause/resume/edit without losing history.
- [ ] Incremental routines: the `State` block in `MEMORY.md` plus content-hash skip, so a daily sweep only processes what changed.
- [ ] Preflight before each scheduled run: budget left, provider reachable, connector auth valid, disk, previous run not still going. A failure notifies and does not consume the slot.

## Definition of done

- [ ] Website routine fires overnight unattended; morning state = diff awaiting approval in-thread; approve → real commit pushed to a test repo; deny → clean abort with receipt.
- [ ] Tweet flow from phone: master drafts 3 variants → tap one → approval → post lands on X test account.
- [ ] Inbox sweep produces morning digest; urgent sender pinned; drafted reply sends only after approval.
- [ ] VM reboot mid-routine: catch-up run executes once and is labeled late.
- [ ] All three connectors show green in `hivekit doctor`.
- [ ] A second routine run over unchanged sources makes **zero model calls** — asserted by counter, not by timing. Clearing `seen` in `MEMORY.md` forces a full re-run.
- [ ] An operator correction recorded in `MEMORY.md` changes behaviour on the next run — the headline reason memory is worth having. Test: reject a draft for a stated reason, assert the next run's master prompt contains that correction and the output complies.
- [ ] A source page carrying an injection payload produces a flagged approval card and **zero tool escalations**; the acting model provably never sees the raw page text.
- [ ] `exec.run` never goes through a shell: `; rm -rf /` passed as an argument is treated literally.
- [ ] `x.post` / `email.send` cannot execute without an approval receipt even in `auto` mode.

Last reviewed: 2026-08-26
