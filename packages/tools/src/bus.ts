/**
 * ToolBus — §4.5 policy gate, implemented as the ONLY execution path.
 *
 * Why one choke point: capability reduction, approval cards and receipt
 * verification are invariants, and invariants enforced at every call site rot;
 * enforced in one constructor-injected bus they cannot be bypassed, because
 * executors are registered here and reachable nowhere else.
 */
import { createHash } from "node:crypto";
import {
  IRREVERSIBLE,
  POLICY_TABLE,
  UNTRUSTED_REVOKES,
  type ApprovalCardPayload,
  type CallRequest,
  type ExecutionContext,
  type GateDecision,
  type Policy,
  type ReceiptRef,
  type ReceiptVerifier,
  type ToolDef,
  type ToolName,
  type ToolResult,
} from "./types";

export interface BusOptions {
  /** Verifies approved receipts for always-ask tools (gateway-backed). */
  verifyReceipt: ReceiptVerifier;
  /**
   * Operator overrides from config/Settings. May only HARDEN ask→always_ask;
   * irreversible tools keep their always_ask floor regardless.
   */
  overrides?: Partial<Record<ToolName, Policy>>;
}

export interface BusCall {
  tool: ToolName;
  input: unknown;
  /**
   * Present when resuming after operator approval. Absent = first attempt;
   * ask/always_ask then return a NeedsApproval decision with a ready card.
   */
  receipt?: ReceiptRef;
}

export class ToolBus {
  readonly #tools = new Map<ToolName, ToolDef<never>>();
  readonly #verify: ReceiptVerifier;
  readonly #overrides;

  constructor(opts: BusOptions) {
    this.#verify = opts.verifyReceipt;
    const o = opts.overrides ?? {};
    for (const [name, policy] of Object.entries(o)) {
      if ((IRREVERSIBLE as readonly string[]).includes(name as ToolName) && policy !== "always_ask")
        throw new Error(`override rejected: ${name} may never be weaker than always_ask`);
    }
    this.#overrides = o;
  }

  register<I>(def: ToolDef<I> & { describe?: (input: I, ctx: ExecutionContext) => Partial<ApprovalCardPayload> }): void {
    if (this.#tools.has(def.name)) throw new Error(`tool ${def.name} already registered`);
    this.#tools.set(def.name, def as unknown as ToolDef<never>);
  }

  has(name: string): name is ToolName {
    return this.#tools.has(name as ToolName);
  }

  list(): ToolName[] {
    return [...this.#tools.keys()];
  }

  /** Effective policy: overrides harden but never weaken the floor table. */
  policy(name: ToolName): Policy {
    const base = POLICY_TABLE[name];
    const o = this.#overrides[name];
    if ((IRREVERSIBLE as readonly string[]).includes(name)) return "always_ask";
    return o ?? base;
  }

  /**
   * §4.5 core invariant as a PURE function: which tools exist for a context?
   * Removal means absence from the offered list — no prompt can talk a task
   * into calling what it cannot see.
   */
  static toolsForContext(hasRawUntrusted: boolean): ToolName[] {
    if (!hasRawUntrusted) return [...Object.keys(POLICY_TABLE)] as ToolName[];
    return (Object.keys(POLICY_TABLE) as ToolName[]).filter(
      (t) => !(UNTRUSTED_REVOKES as readonly string[]).includes(t),
    );
  }

  toolAvailable(name: ToolName, hasRawUntrusted: boolean): boolean {
    return ToolBus.toolsForContext(hasRawUntrusted).includes(name);
  }

  /**
   * The ONLY entry into an executor. Without a receipt, ask/always_ask
   * decisions come back as NeedsApproval carrying the full card payload;
   * execution resumes when the gateway re-calls with the approved receipt.
   */
  async run(
    call: BusCall & CallRequest,
    ctx: ExecutionContext,
    opts: { hasRawUntrusted: boolean; sourceFlagged?: boolean },
  ): Promise<{ decision: GateDecision; result?: ToolResult }> {
    if (!this.has(call.tool))
      return { decision: { go: false, code: "unknown-tool", message: `${call.tool} is not registered` } };

    if (!this.toolAvailable(call.tool, opts.hasRawUntrusted))
      return {
        decision: {
          go: false,
          code: "tool-removed-untrusted",
          message: `${call.tool} does not exist for this context — it holds raw untrusted content`,
        },
      };

    const def = this.#tools.get(call.tool)!;
    const parsed = def.inputSchema.safeParse(call.input);
    if (!parsed.success)
      return { decision: { go: false, code: "bad-input", message: parsed.error.issues[0]?.message ?? "bad input" } };
    const input = parsed.data;

    const policy = this.policy(call.tool);
    if (policy === "allow")
      return { decision: { go: true }, result: await def.execute(input, ctx) };

    if (policy === "ask" && !call.receipt) {
      // Default per §4.5 table: agent-initiated ask runs, since operators may
      // force always_ask via overrides. A receipt resumes with verification below.
      return { decision: { go: true }, result: await def.execute(input, ctx) };
    }

    if (!call.receipt) {
      const card = makeCard(this.#tools.get(call.tool), input, ctx, call.tool, opts.sourceFlagged === true);
      return { decision: { go: false, code: "needs-approval", message: "operator approval required", card } };
    }

    const verdict = await this.#verify(call.receipt);
    if (!verdict.ok)
      return { decision: { go: false, code: "receipt-invalid", message: verifierReason(verdict.reason) } };

    // Receipts are bound to an exact payload — a stale or substituted diff/post fails closed.
    const actual = hashPayload(input);
    if (actual !== call.receipt.payload_hash)
      return {
        decision: {
          go: false,
          code: "receipt-invalid",
          message: `receipt matches different payload (${short(call.receipt.payload_hash)} ≠ ${short(actual)})`,
        },
      };

    return { decision: { go: true }, result: await def.execute(input, ctx) };
  }
}

// ---------------------------------------------------------------- helpers

export function hashPayload(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function short(h: string): string {
  return h.slice(0, 8) + "…";
}

function verifierReason(reason?: string): string {
  return reason ?? "receipt rejected";
}

import type { z } from "zod";

type Describable<I> = ToolDef<I> & { describe?: (input: I, ctx: ExecutionContext) => Partial<ApprovalCardPayload> };

/** Card synthesis: title/summary default to typed facts about the pending action. */
function makeCard(
  def: ToolDef<never> | undefined,
  input: unknown,
  ctx: ExecutionContext,
  tool: ToolName,
  sourceFlagged: boolean,
): ApprovalCardPayload {
  let extra: Partial<ApprovalCardPayload> = {};
  try {
    const described = (def as unknown as Describable<unknown>).describe?.(input, ctx);
    if (described) extra = described;
  } catch {
    /* describe must never block gating */
  }
  return {
    action_kind: kindOf(tool),
    tool,
    job_id: ctx.jobId,
    thread_id: ctx.threadId,
    title: extra.title ?? `${tool} requires approval`,
    diff_preview: extra.diff_preview,
    payload_summary: extra.payload_summary ?? summarize(input),
    source_flagged: sourceFlagged || extra.source_flagged === true,
    requires_receipt_for: tool,
  };
}

const KIND_BY_TOOL: Record<ToolName, import("./types").ActionKind> = {
  "web.fetch": "web",
  "rss.read": "web",
  "fs.read": "fs",
  "fs.write": "fs",
  "site.commit": "commit",
  "site.push": "push",
  "x.draft": "draft_post",
  "x.post": "post",
  "email.fetch": "fetch_mail",
  "email.send": "send_mail",
  "exec.run": "exec",
};

function kindOf(tool: ToolName): import("./types").ActionKind {
  return KIND_BY_TOOL[tool];
}

/** Shallow scalar flattening — receipts show WHAT will happen, never secrets. */
function summarize(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      if (typeof s === "string") out[k] = s.length > 120 ? `${s.slice(0, 119)}…` : s;
    }
  }
  return out;
}
