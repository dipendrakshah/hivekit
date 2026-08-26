# 05 — Web app (the only client)

Goal: one responsive app that makes desktop feel like Slack-with-teeth and phone feel like texting your hive.

## Work

- [ ] App shell served by gateway: nav rail (desktop) ↔ bottom tabs (phone); Threads, Routines, Jobs, Models, Connectors, Receipts, Settings.
- [ ] Thread view: operator/master/worker/system messages; plan cards with task pills; worker updates collapsed by default; artifact rendering (md/html preview/img/csv table/diff).
- [ ] Inline approval cards: diff or payload preview, Approve / Edit / Deny, idempotent taps, optimistic state + server confirm.
- [ ] Composer: send, stop-job button while running, model badge showing current master/worker.
- [ ] Live spend on the job card, and the master/worker split visible — never a spinner without a real task or token count behind it.
- [ ] WS reconnect with a cursor: a phone that loses signal for four minutes catches up rather than reconnecting into a gap.
- [ ] First-run flow: set passkey → paste provider key → pick master/worker from catalog (or raw slug) → sample prompt.
- [ ] Routines tab: list with next-run countdown, pause/resume/edit, notify policy picker.
- [ ] Connectors tab: site repo URL, X handle+keys, IMAP/SMTP settings → vault writes; status dots; never echo secrets back.
- [ ] Receipts tab: filterable log of every approval decision.
- [ ] Mobile pass: 360 px width usable one-handed; approval card thumb-reachable; PWA manifest for add-to-home-screen.

## Definition of done

- [ ] Desktop Chrome + iOS Safari + Android Chrome complete the full journey: login → first job → approve push → read digest.
- [ ] Approval flow works at 3G throttling without duplicate actions (idempotency proven).
- [ ] No raw secret ever appears in network responses after save (verified via devtools).
- [ ] Lighthouse perf ≥ 85 and a11y ≥ 90 on the thread view.
- [ ] An 8-worker fan-out stays under a documented events-per-second ceiling — coalesced server-side, not by the browser.
- [ ] The approval card is completable with a screen reader, and Approve is never the default focus.
- [ ] No page scrolls horizontally at 360 px; diffs and tables scroll inside their own container.

Last reviewed: 2026-08-26
