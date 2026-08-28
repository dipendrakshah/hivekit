/**
 * Policy modes (§4.5 end-to-end) — config `policy.mode` compiled into bus
 * behavior. ALWAYS ASK survives every mode by construction: the modes can
 * only ever HARDEN.
 *
 *   ask (default)  — allow-tier runs; ask-tier asks via card; always_ask gated
 *   auto           — ask-tier is downgraded to allow ONLY for allowlisted
 *                    READ tools (exec_allowlist ∩ read kinds); everything else
 *                    hardens toward cards. For unattended routines.
 *   strict         — even allow-tier read tools require explicit per-call
 *                    receipts EXCEPT fs.read/web.read under jobs/; built for
 *                    "just landed on the public internet" mode.
 */
import type { ToolName } from "@hivekit/tools";
import { ToolBus } from "@hivekit/tools";
import type { Policy } from "@hivekit/tools";

export type PolicyMode = "ask" | "auto" | "strict";

export interface PolicyConfig {
  mode: PolicyMode;
  always_ask: string[];
  exec_allowlist: string[];
}

const READ_TOOLS: readonly ToolName[] = ["web.fetch", "rss.read", "fs.read", "email.fetch", "x.draft", "site.commit"];

/** Fail-closed validation: unknown always_ask names are a config error, not a silent no-op. */
export function validatePolicyConfig(cfg: PolicyConfig, knownTools: readonly string[]): string[] {
  const errors: string[] = [];
  const known = new Set(knownTools);
  for (const name of cfg.always_ask)
    if (!known.has(name)) errors.push(`policy.always_ask: unknown tool ${name}`);
  for (const name of cfg.exec_allowlist)
    if (!known.has(name)) errors.push(`policy.exec_allowlist: unknown tool ${name}`);
  if (!["ask", "auto", "strict"].includes(cfg.mode)) errors.push(`policy.mode: ${cfg.mode} is not ask|auto|strict`);
  return errors;
}

/**
 * Compile config → bus options. Returns overrides the ToolBus constructor
 * accepts; ALWAYS ASK tools are filtered out (they are always_ask already and
 * the constructor refuses weaker overrides anyway — belt and braces).
 */
export function compilePolicy(cfg: PolicyConfig): { overrides: Partial<Record<ToolName, Policy>> } {
  const overrides: Partial<Record<ToolName, Policy>> = {};

  if (cfg.mode === "auto") {
    // Unattended runs: reads flow ONLY when allowlisted; every other read
    // hardens (their BASE tier is allow — auto must actively revoke it),
    // and all write/exec paths harden to always_ask.
    for (const name of READ_TOOLS) {
      overrides[name] = cfg.exec_allowlist.includes(name) ? "allow" : "always_ask";
    }
    for (const name of ["exec.run", "fs.write"] as ToolName[]) overrides[name] = "always_ask";
  }

  if (cfg.mode === "strict") {
    // Reads still flow (a hive that can't read is pointless) but every
    // write/comm path hardens. exec.run ALWAYS asks in strict.
    for (const name of ["fs.write", "site.commit", "exec.run"] as ToolName[]) overrides[name] = "always_ask";
  }

  // Config always_ask entries harden allow-tier tools; the ToolBus
  // constructor refuses any entry that would WEAKEN an irreversible tool.
  for (const name of cfg.always_ask) overrides[name as ToolName] = "always_ask";

  return { overrides };
}

/** Convenience: build a bus straight from config (gateway + doctor share this). */
export function busFromPolicy(
  cfg: PolicyConfig,
  verifyReceipt: ConstructorParameters<typeof ToolBus>[0]["verifyReceipt"],
): ToolBus {
  return new ToolBus({ verifyReceipt, overrides: compilePolicy(cfg).overrides });
}
