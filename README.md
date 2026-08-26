# Hivekit

**Bring your own key. One master. Many workers. Jobs that finish.**

Hivekit is a *simple* personal multi-agent workshop inspired by [OpenClaw](https://github.com/openclaw/openclaw) (formerly Clawd / Clawdbot / Moltbot) and by Grok-style master + sub-agent fan-out — without the 70k-line octopus.

You paste an API key from OpenRouter, Anthropic, OpenAI, Groq, a local Ollama box, or any OpenAI-compatible gateway. You pick a **master model** (planner) and a **worker model** (doers). The master splits a job. Workers run in parallel. They report back. The master ships the artifact.

This repository is the **v0 design pack**: product requirements, system architecture, agent instructions, mock UIs, example skills, and an exhaustive definition-of-done backlog. Implementation comes after these documents are accepted.

## Why this exists

OpenClaw is excellent and huge. Hivekit's constraints:

- Setup in under 15 minutes on a laptop.
- One YAML file for models, keys, and roles.
- Master and worker models are independently configurable.
- Free / stealth models (for example OpenRouter `stealth/ox-alpha`, often written `0xAlpha`) are first-class workers.
- Jobs are file-native: PDFs, invoices, HTML sites, spreadsheets, images, code.
- Three surfaces, one Gateway: Electron on macOS, Android companion, cloud web app.

## Read in this order

1. [PRD.md](PRD.md) — what we are building and what we are not.
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit.
3. [docs/agents/AGENT_INSTRUCTIONS.md](docs/agents/AGENT_INSTRUCTIONS.md) — how every agent must behave.
4. [docs/ui/README.md](docs/ui/README.md) — mock UIs (open the HTML files in a browser).
5. [todo/README.md](todo/README.md) — exhaustive backlog with definition of done.

## Design principles

1. **BYOK, not a model company.** Hivekit never sells inference. Keys stay on the device or in the operator's vault.
2. **Master plans, workers execute, humans approve risk.**
3. **Files are the API.** A job that cannot write a file the operator can open has not finished.
4. **Config over code.** Changing Claude Fable 5 → Ox Alpha as the worker is a YAML edit, not a rebuild.
5. **Smaller than OpenClaw.** No 26 chat channels in v1. Chat lives in Hivekit's own clients. Channels can arrive later as plugins.

## Example jobs (v1 target)

- Keep a personal news site updated from RSS + web research.
- Build a tax-history dashboard from a folder of invoices and receipts.
- Turn a messy downloads folder into a structured workshop with summaries.

## Status

Design / specification. No runtime yet. See `todo/`.

## License

MIT. See [LICENSE](LICENSE).
