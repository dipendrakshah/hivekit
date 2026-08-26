# Hivekit UI mock

One responsive web app served by the Gateway itself — desktop and phone are the same app, the way you message a teammate. Open [app.html](app.html) in any browser; it is static and self-contained.

| Frame | What it shows |
| --- | --- |
| Desktop | Thread with plan card, worker update, inline approval card (diff + approve/edit/deny), status rail with routines/connectors/spend |
| Phone | Same thread, bottom tabs, approval card sized for a thumb |

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
