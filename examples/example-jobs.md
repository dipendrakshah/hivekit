# Example jobs (paste-ready)

No skills system in v1 — behavior comes from the thread. These are first messages and routines that exercise every v1 connector. Each maps to a PRD §6 journey.

## 1 · One-shot briefing (no connector)

```
Summarize these three URLs into briefing.md:
- https://example.com/a
- https://example.com/b
- https://example.com/c
Fetch them in parallel, cross-check any overlapping claims, and keep it under 400 words.
```

Proves: plan card, parallel workers, artifact in-thread.

## 2 · Morning website updates (routine, site connector)

Paste in-thread, then confirm the routine card:

```
Every morning at 07:00 Asia/Kolkata: scan these five sources for news about
<topic>, fact-check the two best items with quotes and dates, draft an update
post for my site repo in its existing voice, commit to branch routine/<date>,
and show me the diff before pushing. Sources: <rss/url list>.
```

Proves: web fan-out, git draft + approval-card push, routine persistence.

## 3 · Tweet updates (x connector)

```
I just pushed a post. Draft three tweet variants in my voice — one punchy,
one detailed, one question hook — under 280 chars each. I'll pick one to post.
```

Then weekly:

```
Every Monday 09:00: pull engagement for last week's posts and post a digest
in this thread.
```

Proves: draft-by-default, approval-gated `x.post`, scheduled digests.

## 4 · Email tracking (email connector)

```
Watch my inbox. Poll hourly, keep a running triage: client mail = urgent,
newsletters = skip, receipts = file. Every morning at 08:00 give me a digest
with the three things that actually need me. Never send anything without my
explicit approval; draft replies only when I ask.
```

Proves: IMAP poll, notify-on-urgent policy, always-ask external send.

## 5 · Model swap drill

Mid-job, change worker model in Settings → next spawned workers use it; in-flight finish on the old model. Proves FR-M3/G2 hot-swap.

## Definition of done

A stranger runs examples 1–4 on a fresh hive without opening source files (PRD §12).
