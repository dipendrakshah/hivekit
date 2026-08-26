# Hivekit backlog

Each file in this folder is a milestone workstream. A stream is **done** only when every checkbox in its "Definition of done" section is true and evidenced (command output, screenshot path, or test name).

Do not mark a stream done because the code exists. Mark it done because an operator can feel the behavior on a real VM.

## Order

| # | File | Depends on |
| --- | --- | --- |
| 0 | [00-overview.md](00-overview.md) | — |
| 1 | [01-foundation.md](01-foundation.md) | 0 |
| 2 | [02-models-agents.md](02-models-agents.md) | 1 |
| 3 | [03-connectors-routines.md](03-connectors-routines.md) | 2 |
| 4 | [04-web-app.md](04-web-app.md) | 2 |
| 5 | [05-security-release.md](05-security-release.md) | 3, 4 |

Streams 3 and 4 can proceed in parallel once 2 lands.

## Done-done for v1

The product ships when streams 1–5 are done and a stranger who did not write the code has: deployed on EC2 in ≤ 15 minutes, approved a site push from their phone, and received an unattended overnight routine run.
