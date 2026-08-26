# 02 — Model adapters and BYOK

## What to do

Make "any model, any key" real.

Work:

1. `packages/models` with `openai_compat` and `anthropic` adapters.
2. Vault interface: set / get / delete by `vault_ref`. Fake driver for tests, keychain driver later (stream 10).
3. Role resolution: `roles.master.model` and `roles.worker.model` from YAML.
4. Raw model id passthrough (operator can type `stealth/ox-alpha`).
5. Optional `/models` catalog cache for OpenRouter.
6. Fallback: on 429 / 5xx / timeout, try `fallback` once.
7. Token and USD accounting written to the job row (price table can be a static map + "unknown = 0 with warning").
8. Streaming tokens over WS `event.agent`.

## Definition of done

- [ ] With only an OpenRouter key, master completion succeeds against a named paid or free model.
- [ ] Worker completion can use a *different* model id in the same process.
- [ ] Changing YAML model slugs and sending `req.models.set` changes the next call without a process restart.
- [ ] Ollama at `http://127.0.0.1:11434/v1` works with `vault_ref: none`.
- [ ] Adapter tests use recorded HTTP fixtures, not live keys in CI.
- [ ] A missing key returns a structured error `vault.missing` to the client, not a stack trace.
- [ ] Fallback fires once in a test that stubs primary → 429.
