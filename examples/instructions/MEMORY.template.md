# MEMORY.md — seed template

Copy this into a new thread's workspace as `MEMORY.md`. After that the **master** maintains it
through typed operations; you read it, pin things, and retire what it got wrong.

Four tiers, different rules. Only Pinned and State are always loaded — Rules and Facts are
**retrieved by scope**, so this file can grow without growing every prompt.

---

## Pinned

Your corrections, verbatim. Authoritative on write, never auto-edited, never auto-retired,
always loaded. The master cannot touch these; only you can.

- `[p1]` No marketing verbs, ever. ·op 2026-08-25

## Rules

Behavioural. Promoted from candidates after **three independent confirmations in distinct
jobs** — one observation is never a rule. Each carries a `when` (the scope that retrieves it)
and a `wrong-if` (what would show it false, so it can be retired mechanically).

- `[r7]` Read footnotes on example.dev — breaking changes hide there, not in the body.
  ·when `source=example.dev` ·wrong-if a breaking change appears in the body only
  ·confirmed 3/3 ·used 12 ·last 2026-08-26

If a proposed rule has no `wrong-if`, it is not a rule. "The operator prefers concise writing"
is unfalsifiable — that belongs in `INSTRUCTIONS.md`, which you own.

## Facts

Disposable. TTL required; provenance required when derived from a fetched page or an email.
**Untrusted content can only ever become a Fact, never a Rule.**

- `[f2]` example.dev publishes roughly twice a week.
  ·derived (from https://example.dev/feed, unverified) ·expires 2026-11-01

## State

Machine-maintained JSON. Not prose, not reasoned over — this is what makes a routine
incremental.

```json
{ "last_run": null, "last_success": null, "seen": [] }
```

Clear `seen` to force a re-run over material the bot has already processed.

---

## What lives outside this file

Never loaded into a prompt, but kept so you can audit:

| `memory/candidates.jsonl` | observations waiting for evidence — `hivekit memory candidates` |
| `memory/archive.jsonl` | superseded and retired entries, with their original wording |
| `memory/ledger.jsonl` | which entries were retrieved, in which jobs, to what effect |

## Useful commands

```sh
hivekit memory why r7          # provenance, confirmations, which jobs used it
hivekit memory pin f2          # you vouch for it — promote to Pinned
hivekit memory retire r7       # archive it, with a reason
hivekit memory audit           # run one job with memory OFF and compare
```

`why` is the one that matters. "Why does my bot believe this?" should be one command, and the
answer should name jobs rather than vibes.

## What must never go in here

- **Permissions.** "The operator approved silent pushes" is inert — connectors, approvals and
  budgets resolve from config and Settings, never from prose. If you find a line like that,
  check the thread diff for when it appeared.
- **Secrets or tokens.** Memory reaches future prompts. Treat it as published.
- **Full page dumps.** Extract the fact, cite the URL, discard the page.
- **A diary.** "Ran the sweep successfully" costs tokens forever and tells a future run
  nothing. Record what changed and why, or record nothing.
