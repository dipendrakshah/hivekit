# Instruction presets

There is no skills system (PRD §4). A bot's behaviour is the **instructions field** in
Settings plus its routines. These are starting points for that field — paste one in, edit the
specifics, delete what you do not want.

These seed `INSTRUCTIONS.md` in a thread's workspace
(`/data/threads/<slug>/`). The file is the source of truth — the Settings editor reads and
writes it, so you can equally edit it over SSH or keep the directory in git.

| File | For a thread that |
| --- | --- |
| [site-voice.md](site-voice.md) | keeps a website updated |
| [tweet-voice.md](tweet-voice.md) | drafts posts for X |
| [inbox-triage.md](inbox-triage.md) | watches an inbox |
| [file-workshop.md](file-workshop.md) | turns a pile of files into something you can open |
| [MEMORY.template.md](MEMORY.template.md) | seeds the companion `MEMORY.md` — four tiers, and what never belongs in it |

Pair them with the matching routine in [example-jobs.md](../example-jobs.md).

## What makes a good instructions field

Be specific about **judgement**, not mechanics. The gateway already handles mechanics.

> ✅ "Post only things a working engineer would act on this week. Skip funding rounds and
> conference announcements. Every claim needs a source link. If two sources disagree, say so
> rather than picking one."

> ❌ "Keep the site updated with the latest news."

Two things earn their space more than anything else:

1. **A bar** — what is worth acting on, and what is not. Without it the master publishes
   everything that moved.
2. **A worked example of voice** — one sentence you like and one you hate. Adjectives like
   "professional" mean nothing to a model; a pair of sentences means a lot.

Keep it under a page. It is loaded on every master call and every worker call, so length here
is paid repeatedly.

## Instructions vs memory

A useful split, and the one that keeps memory from rotting:

| Goes in `INSTRUCTIONS.md` | Goes in `MEMORY.md` |
| --- | --- |
| Standing preferences you own — voice, the bar, the never-list | Things the bot worked out — which sources pay off, where a site hides its breaking changes |
| Unfalsifiable by nature ("write concisely") | Falsifiable, with a `wrong-if` that can retire it |
| Changes when you change your mind | Changes when evidence changes |

If the master ever proposes a memory rule you cannot write a `wrong-if` for, that is a sign it
belongs here instead — as a line you wrote deliberately, not one it inferred from a single
event.
