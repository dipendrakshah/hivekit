# 12 — Docs and release

## What to do

Make the design pack and the future runtime tell the same story.

Work:

1. README install path matches reality.
2. Changelog started.
3. License headers where required.
4. Tag `v0.1.0-design` for this documentation-only repo.
5. When runtime exists, tag `v0.2.0` only after streams 1–11 are done.
6. Keep AGENT_INSTRUCTIONS.md under 400 lines.

## Definition of done

- [ ] `README.md` links PRD, architecture, agent instructions, UI mocks, todo.
- [ ] No secret or live API key in git history (`gitleaks` or equivalent clean).
- [ ] Design tag pushed.
- [ ] Contributor can add a skill by dropping a folder and opening a PR that only touches `skills/`.
