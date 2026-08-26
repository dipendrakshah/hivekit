# Hivekit backlog

Each file in this folder is a milestone workstream. A stream is **done** only when every checkbox in its "Definition of done" section is true and evidenced (command output, screenshot path, or test name).

Do not mark a stream done because the code exists. Mark it done because an operator can feel the behavior on a real VM.

## Order

| # | File | Depends on |
| --- | --- | --- |
| 0 | [00-overview.md](00-overview.md) | — |
| 1 | [01-foundation.md](01-foundation.md) | 0 |
| 2 | [02-memory.md](02-memory.md) | 1 |
| 3 | [03-models-agents.md](03-models-agents.md) | 1, 2 |
| 4 | [04-connectors-routines.md](04-connectors-routines.md) | 3 |
| 5 | [05-web-app.md](05-web-app.md) | 3 |
| 6 | [06-security-release.md](06-security-release.md) | 4, 5 |

Streams 4 and 5 can proceed in parallel once 3 lands.


## Done-done for v1

The product ships when streams 1–6 are done and a stranger who did not write the code has: deployed on EC2 in ≤ 15 minutes, approved a site push from their phone, and received an unattended overnight routine run.
