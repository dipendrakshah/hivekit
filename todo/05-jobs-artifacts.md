# 05 — Jobs, tools, artifacts

## What to do

Give agents hands and a place to put results.

Work:

1. SQLite schema for Job and Task.
2. Tools: fs.*, web.fetch, pdf.extract, office.extract, exec.run, git.commit, git.push.
3. Policy layer (`ask` / `auto` / `strict`) + approval records.
4. Promote step: master-listed files copy to `out/` atomically.
5. `jobs/<id>/REPORT.md` and `trace.jsonl` always written on terminal state.
6. Binary handling: hash, extract text, optional thumbnail.

## Definition of done

- [ ] `web.fetch` wraps body in an untrusted marker before it enters a prompt (assert in test).
- [ ] `exec.run("rm -rf /")` is denied even in `auto`.
- [ ] `git.push` always creates `event.approve` and does not run before `req.job.approve`.
- [ ] PDF fixture extracts at least one line of known text.
- [ ] CSV / xlsx fixture yields rows as JSON.
- [ ] Failed job still has REPORT.md explaining the failure.
- [ ] Promotion does not overwrite `out/` without a backup or version stamp.
