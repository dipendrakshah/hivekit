/**
 * @hivekit/models — adapters + catalog cache (stream 03).
 *
 * Locked design (ARCHITECTURE §4.4): plain `fetch` against OpenAI-compatible
 * `/chat/completions` and Anthropic's messages API; no vendor SDKs; every call
 * carries required `{thread_id, job_id, task_id}` attribution so the spend log
 * is complete rather than approximate.
 *
 * Stream 01 ships the attribution type only — the compile-error guard that
 * makes an unattributed model call impossible before any adapter exists.
 */

/** Required on EVERY completion call — stream 03 enforces this at compile time. */
export interface CallAttribution {
  thread_id: string;
  job_id: string;
  task_id: string | null;
}

/** Placeholder export so the package is importable in stream 01. */
export const MODELS_PACKAGE = "stream-03";