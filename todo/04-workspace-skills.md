# 04 — Workspace, index, skills

## What to do

Make the folder on disk the source of truth.

Work:

1. Load SOUL / AGENTS / USER / TOOLS / IDENTITY / HEARTBEAT with token budgets.
2. Skill catalog from `skills/` (repo) + `workspace/skills/` (private).
3. Match skill by name or by a cheap embedding/keyword pass. v1 keyword + explicit mention is enough.
4. File index: path, size, mtime, extension, optional text extract for small files.
5. Path guard: tools cannot escape workspace even via `..` or symlink out.
6. `inbox/`, `jobs/`, `out/`, `memory/` created on init.

## Definition of done

- [ ] Prompt assembly unit test snapshots include SOUL and exclude a non-matched skill body.
- [ ] Symlink-escape test fails closed.
- [ ] Adding `skills/foo/SKILL.md` makes `foo` appear in the catalog endpoint.
- [ ] HEARTBEAT.md with a valid cron registers a job; `every: "0m"` disables it.
- [ ] Index refresh is incremental (touch one file, only that row changes).
