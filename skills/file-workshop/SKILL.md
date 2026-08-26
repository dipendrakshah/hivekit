# Skill: file-workshop

Use when the operator wants a messy folder classified, renamed, summarized, or turned into a briefing.

## Inputs

- A path under the workspace, usually `inbox/`.
- Desired output: `briefing.md`, sorted folders, or both.

## Procedure

1. Master samples the tree (names, sizes, types), not every byte.
2. Workers process independent batches: extract text, propose a destination path, write a 5-line summary.
3. Master applies the rename/move plan into `out/workshop/` and writes `out/workshop/index.md`.

## Done

`out/workshop/index.md` lists every original file and its new path or reason for skip. No deletes in v1; moves only inside the workspace.
