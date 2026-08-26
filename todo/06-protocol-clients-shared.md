# 06 — Protocol and shared web UI

## What to do

Specify and implement the WebSocket protocol and the shared frontend that Electron and cloud both wrap.

Work:

1. Freeze frame types in `packages/protocol` with JSON schema.
2. Auth token on hello.
3. Shared app: chat transcript, job timeline, swarm cards, model role pickers, workspace tree, approval modal.
4. Streaming tokens render in place.
5. File drop → upload into `inbox/`.
6. Design tokens match the mocks in `docs/ui` (warm dark, copper accent).

## Definition of done

- [ ] Protocol schemas generate types; a bad frame is rejected with `protocol.error`.
- [ ] Shared UI runs at `http://127.0.0.1:8787` when Gateway is up.
- [ ] Model pickers show master and worker separately and persist via `req.models.set`.
- [ ] Approval modal can accept / reject a `git.push` request.
- [ ] Visual: side-by-side screenshot vs `docs/ui/web-cloud.html` stored under `qa/ui/`.
- [ ] Accessibility: keyboard can send a chat message and approve a job.
