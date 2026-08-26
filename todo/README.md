# Hivekit backlog

Each file in this folder is a workstream. A workstream is **done** only when every checkbox in its "Definition of done" section is true and evidenced (command output, screenshot path, or test name).

Do not mark a stream done because the code exists. Mark it done because an operator can feel the behavior.

## Order

| # | File | Depends on |
| --- | --- | --- |
| 0 | [00-overview.md](00-overview.md) | — |
| 1 | [01-foundation.md](01-foundation.md) | 0 |
| 2 | [02-model-gateway.md](02-model-gateway.md) | 1 |
| 3 | [03-master-worker.md](03-master-worker.md) | 2 |
| 4 | [04-workspace-skills.md](04-workspace-skills.md) | 1 |
| 5 | [05-jobs-artifacts.md](05-jobs-artifacts.md) | 3, 4 |
| 6 | [06-protocol-clients-shared.md](06-protocol-clients-shared.md) | 1 |
| 7 | [07-electron-macos.md](07-electron-macos.md) | 6, 5 |
| 8 | [08-web-cloud.md](08-web-cloud.md) | 6, 5 |
| 9 | [09-android.md](09-android.md) | 6, 5 |
| 10 | [10-security-vault.md](10-security-vault.md) | 2 |
| 11 | [11-example-jobs.md](11-example-jobs.md) | 5, 7 or 8 |
| 12 | [12-docs-release.md](12-docs-release.md) | 11 |

## Done-done for the v1 product

The product ships when streams 1–12 are done and the three sample jobs in stream 11 have been run by someone who did not write the code.
