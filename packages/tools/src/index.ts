/**
 * @hivekit/tools — tool bus + policies (stream 04).
 *
 * Locked design (ARCHITECTURE §4.5): allow / ask / always-ask policy gate;
 * untrusted content REMOVES external-send tools from a task's tool list
 * (absent, not denied); every always-ask action writes an Approval receipt.
 * `exec.run` never goes through a shell.
 *
 * Stream 01 ships the policy vocabulary only — the gateway's policy gate in
 * stream 04 consumes it; defining it now keeps the config loader honest.
 */

export type ToolPolicy = "allow" | "ask" | "always-ask";

/** The set that is enforced in every mode (PRD FR-S2). */
export const ALWAYS_ASK: readonly string[] = [
  "site.push",
  "x.post",
  "email.send",
  "exec.run",
];

/** A task holding raw untrusted content loses these tools entirely (FR-S5). */
export const UNTRUSTED_REVOKES: readonly string[] = [
  "site.push",
  "x.post",
  "email.send",
  "exec.run",
];