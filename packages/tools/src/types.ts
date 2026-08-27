/**
 * Tool bus types (§4.5).
 *
 * Design invariant: EVERYTHING dangerous is a type here. Tool names come from
 * this module; executors take typed inputs; irreversible tools require an
 * approved receipt ref that the BUS verifies — callers cannot skip it.
 */
import type { z } from "zod";

/** The complete v1 tool list — new connectors must register here first. */
export const TOOL_NAMES = [
  "web.fetch",
  "rss.read",
  "fs.read",
  "fs.write",
  "site.commit",
  "site.push",
  "x.draft",
  "x.post",
  "email.fetch",
  "email.send",
  "exec.run",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * allow       — run on the agent's word
 * ask         — run unless operator set it to always-ask in config
 * always_ask  — every call needs an approved receipt; config cannot downgrade
 */
export type Policy = "allow" | "ask" | "always_ask";

export type ActionKind = "web" | "fs" | "commit" | "push" | "draft_post" | "post" | "fetch_mail" | "send_mail" | "exec";

export const POLICY_TABLE: Record<ToolName, Policy> = {  "web.fetch": "allow",
  "rss.read": "allow",
  "fs.read": "allow",
  "fs.write": "allow", // scoped to jobs/ by the executor; ask elsewhere at gateway level
  "site.commit": "allow",
  "site.push": "always_ask",
  "x.draft": "allow",
  "x.post": "always_ask",
  "email.fetch": "allow",
  "email.send": "always_ask",
  "exec.run": "ask",
};

/** Tools whose effects cannot be undone. Config may never downgrade these. */
export const IRREVERSIBLE: readonly ToolName[] = ["site.push", "x.post", "email.send"];

/** §4.5: tools removed while a task's context holds RAW untrusted content. */
export const UNTRUSTED_REVOKES: readonly ToolName[] = ["site.push", "x.post", "email.send", "exec.run"];

export interface ToolDef<I = unknown> {
  name: ToolName;
  kind: ActionKind;
  inputSchema: z.ZodType<I>;
  /** Executed only after the bus decided "go". Executors must be side-effect-safe to test. */
  execute: (input: I, ctx: ExecutionContext) => Promise<ToolResult>;
  /** Builds the approval-card specifics for gated tools; the bus supplies defaults around it. */
  describe?: (input: I, ctx: ExecutionContext) => Partial<ApprovalCardPayload>;
}

export interface ExecutionContext {
  jobId: string;
  threadId: string;
  taskId?: string;
  /** Which model prompted this call — lands in the receipt. */
  model?: string;
  /** Scratch dir under the thread workspace; fs tools are jailed here. */
  workDir: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** For read-only tools: text that will be tagged untrusted before entering context. */
  output?: string;
  structured?: unknown;
  error?: string;
}

// ---------------------------------------------------------------- receipts

/**
 * Opaque evidence that an ALWAYS_ASK action was approved. Produced by the
 * gateway when the operator taps approve; verified here before execution.
 * A receipt is SINGLE-USE for a matching payload hash — replay of a stale or
 * mismatched receipt is rejected.
 */
export interface ReceiptRef {
  id: string;
  action_kind: ActionKind;
  payload_hash: string;
  approved_by: string;
  approved_at: string;
  model?: string;
}

export type ReceiptVerifier = (ref: ReceiptRef) => Promise<{ ok: boolean; reason?: string }>;

// ---------------------------------------------------------------- frames

export type GateDecision =
  | { go: true }
  | { go: false; code: "tool-removed-untrusted"; message: string }
  | { go: false; code: "needs-approval"; message: string; card: ApprovalCardPayload }
  | { go: false; code: "receipt-invalid" | "unknown-tool" | "bad-input"; message: string };

export interface ApprovalCardPayload {
  action_kind: ActionKind;
  tool: ToolName;
  job_id: string;
  thread_id: string;
  title: string;
  diff_preview?: string;
  payload_summary: Record<string, string>;
  source_flagged?: boolean;
  requires_receipt_for: ToolName;
}

export type BusCall =
  | { kind: "direct"; tool: ToolName; input: unknown }
  | { kind: "gated"; tool: ToolName; input: unknown; card: ApprovalCardPayload }
  | { kind: "approved"; tool: ToolName; input: unknown; card: ApprovalCardPayload; receipt: ReceiptRef };

/** The invocation envelope the model's structured call compiles into. */
export interface CallRequest {
  tool: ToolName;
  input: unknown;
}
