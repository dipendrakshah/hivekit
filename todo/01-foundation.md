# 01 — Foundation: repo, CLI, Gateway process

## What to do

Stand up the monorepo and a Gateway that boots, loads YAML, serves health, and can be stopped cleanly.

Work:

1. Create packages: `apps/gateway`, `apps/web` placeholder, `packages/protocol`.
2. Node 22 + TypeScript ESM + one test runner (node:test or vitest). Pick one and write it in README.
3. `hivekit` CLI stubs: `init`, `doctor`, `gateway`, `vault set`, `version`.
4. `init` copies `templates/workspace/*` and `config/hivekit.example.yaml` to `~/.hivekit/`.
5. Gateway reads config, binds `127.0.0.1:8787`, answers `GET /health` and WS `req.hello`.
6. Graceful shutdown on SIGINT. Second instance refuses the port with a readable error.
7. Docker Compose: gateway + volume for workspace.

## Definition of done

- [ ] `hivekit init && hivekit doctor && hivekit gateway` works on macOS and Linux without extra undocumented env vars.
- [ ] `curl -s localhost:8787/health` returns JSON `{ ok, version, workspace }`.
- [ ] Two gateways on the same port: the second prints "already running" and exits non-zero.
- [ ] `init` is idempotent: running twice does not overwrite a dirty `USER.md`.
- [ ] Unit test for config load (missing file, bad YAML, default port).
- [ ] Compose file documented in README; `docker compose up` reaches `/health`.
