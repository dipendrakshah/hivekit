# Hivekit UI mock

One responsive web app served by the Gateway itself — desktop and phone are the same app, the way you message a teammate. Open [app.html](app.html) in any browser; it is static and self-contained.

| Frame | What it shows |
| --- | --- |
| Desktop | Thread with plan card, worker update, inline approval card (diff + approve/edit/deny), status rail with routines/connectors/spend |
| Phone | Same thread, bottom tabs, approval card sized for a thumb |
| Routine confirm | Plain language → `{cron, prompt, connectors, notify}` shown back as a card. Nothing persists until you tap Save |
| Settings · models | The split-brain screen: master seat, worker seat, and what a swap would cost |
| Receipts | Every irreversible action with payload, decider, model and timestamp |
| Thread memory | The four tiers, what was actually retrieved for this job, candidates awaiting evidence, and the hold-out audit |

## Patterns borrowed from Grok Bot (x.ai/bot)

- **Thread is the interface** — tasks, plans, approvals, artifacts all arrive as messages. No separate jobs console for daily use.
- **Inline approval cards** — irreversible actions come back in-thread with diff/payload preview, never a settings-style modal.
- **Routines from conversation** — recurring jobs appear as first-class cards ("daily 07:00 · next 06:59") manageable without leaving the thread.
- **Notify policies** — ping only when approval is needed by default; escalate to `always` per routine.

## Design tokens (implement these in `apps/web`)

- Background `#12110e`
- Panel `#1c1a16`
- Line `#2e2a24`
- Text `#ece8df`
- Mute `#9a9286`
- Copper `#d4783a`
- Sage `#7a9e7e`
- Danger `#c45c4a`
- Warn `#c9a227`
- Font UI: `"IBM Plex Sans"`
- Font mono: `"IBM Plex Mono"`

Do not replace this with a generic purple-on-navy AI dashboard. The product is a workshop thread, not a chatbot landing page.

## Rules every screen follows

1. **The thread is the interface.** If a daily action needs a separate console, the design is
   wrong. Settings and Receipts exist for the things you do monthly, not daily.
2. **Cost is always visible** — on the plan card, on the job rail, on the model settings.
   Estimates are labelled as estimates and never blended into measured spend.
3. **Which model did it is always visible**, including on an escalation: the model that failed
   and the model that succeeded. That is how you learn which of your models to trust.
4. **Nothing irreversible without the effect.** The diff, the tweet text, the email body. If an
   effect genuinely cannot be previewed, the card says so rather than hiding it.
5. **Failure is information.** Retries and escalations show in the plan card. A free worker
   failing twice and a good one succeeding is the design working, not something to hide.
6. **Never a spinner alone.** Every progress indicator is backed by a real task or token count.
   "Is it stuck?" should never need asking.
7. **Memory writes are visible.** What a bot decides to remember lands in the thread as a diff,
   never as a silent append — a durable false belief is far more expensive than a wrong answer,
   and the diff is where you catch it.
8. **Show what was retrieved, not what is stored.** The memory screen leads with the handful of
   entries that actually entered this job's prompt, and says how many did not. Storage is a
   number; retrieval is what changed the answer.

## Accessibility floor

- Status is never colour-only — every pill carries a word (`ok`, `run`, `wait`), not just a hue.
- The approval card is the one flow used under time pressure: fully labelled, and **Approve is
  never the default focus**.
- Diffs, tables and long payloads scroll inside their own container. The page body never
  scrolls horizontally at 360 px.
- Target Lighthouse a11y ≥ 90 on the thread view (see `todo/05-web-app.md`).

## Not mocked

First-run (passkey → key → model picker → sample prompt), the Jobs list, and the Connectors
form. All conventional, and none carries a design decision worth arguing about in a mock.
