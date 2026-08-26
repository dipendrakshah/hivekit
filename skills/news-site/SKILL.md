# Skill: news-site

Use when the operator wants a personal news site kept current: static HTML, markdown blog, or a folder of posts.

## Inputs

- Site root (git repo or folder) from USER.md or the prompt.
- Optional topic allowlist and blocklist.
- Last-run stamp in `out/news-site/state.json`.

## Procedure

1. Master reads `state.json` and the site layout (`index.html` or `posts/`).
2. Worker A: gather candidate items (RSS, sites listed in `out/news-site/sources.md`). Write `jobs/<id>/candidates.json`.
3. Worker B: for each new candidate, fetch page text, write a draft post in `jobs/<id>/drafts/`.
4. Worker C (or reviewer): drop items that are old, duplicate, or unsourced. Mark claims that need a link.
5. Master merges accepted drafts into the site tree, updates index, writes `state.json`.
6. Commit only after approval.

## Output contract

- `out/news-site/state.json` with `last_run` and accepted ids.
- New posts on disk.
- `jobs/<id>/REPORT.md` listing accepted / rejected with reasons.

## Done

The site builds or opens locally. Every published item has a source URL. No commit without approval.
