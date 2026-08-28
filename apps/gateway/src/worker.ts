/**
 * Worker task executor (§4.3 worker pool, depth 1).
 *
 * One worker = one task = isolated session. It gets:
 *   - the task spec + ATTESTED findings from prior tasks (never raw page text
 *     from other tasks — raw untrusted text exists only inside reader workers)
 *   - a ToolBus scoped to THIS job, with rawUntrusted=true exactly when the
 *     task is a reader — which REMOVES site.push/x.post/email.send/exec.run
 *     from its tool list before the model ever sees it (§4.5)
 *   - a loop guard: 8 tool calls, wall-clock timeout, identical repeated
 *     calls answered with "you already did that" (§4.5 table)
 *
 * Results are STRICT JSON validated code-first through the FR-A6 ladder —
 * a model never grades another model's work.
 */
import { z } from "zod";
import { ToolBus, type ReceiptRef, type ApprovalCardPayload } from "@hivekit/tools";
import { runLadder, type ValidatorResult } from "@hivekit/models";
import type { CompletionRequest } from "@hivekit/models";
import type { PlanTask } from "./planner";

export interface WorkerFinding {
  fromTask: string;
  text: string;
  /** Citation locators make findings attested data (§4.5). */
  citations: string[];
}

export interface TaskContext {
  jobId: string;
  threadId: string;
  taskId: string;
  workDir: string;
  instructions: string;
  memoryBlock: string;
  findings: WorkerFinding[];
  model: { provider: import("@hivekit/models").ProviderId; id: string };
  /** May return null when no fallback configured — ladder then uses 2 arms. */
  fallbackModel: () => { provider: import("@hivekit/models").ProviderId; id: string } | null;
  complete: (req: CompletionRequest) => Promise<{ text: string }>;
  /** Bus pre-registered with THIS job's allowed tools. */
  bus: ToolBus;
  /** Detect duplicate calls; gateway passes a per-task set. */
  seenCalls?: Set<string>;
  wallClockMs: number;
  /** payloadHash binds the receipt to the EXACT tool input the bus will verify. */
  onApprovalNeeded: (card: ApprovalCardPayload, payloadHash: string) => Promise<ReceiptRef | null>;
  onDelta?: (text: string) => void;
}

export const WorkerResultSchema = z.object({
  status: z.enum(["ok", "blocked", "failed"]),
  findings: z.array(z.object({ text: z.string().min(1), citations: z.array(z.string()).default([]) })).default([]),
  artifacts: z.array(z.string()).default([]),
  notes: z.string().max(2000).default(""),
  blockers: z.array(z.string()).default([]),
  /** Claimed against the task's success sentence — merge verifies coherence. */
  success_claimed: z.boolean().default(false),
});

export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export interface TaskOutcome {
  status: "ok" | "blocked" | "failed";
  result?: WorkerResult;
  error?: string;
  attempts: number;
  toolCalls: number;
}

const RESULT_SCHEMA_JSON = JSON.stringify({
  type: "object",
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["ok", "blocked", "failed"] },
    findings: { type: "array", items: { type: "object", required: ["text"], properties: { text: { type: "string" }, citations: { type: "array", items: { type: "string" } } } } },
    artifacts: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    blockers: { type: "array", items: { type: "string" } },
    success_claimed: { type: "boolean" },
  },
});

export async function runTask(task: PlanTask, ctx: TaskContext): Promise<TaskOutcome> {
  const seen = ctx.seenCalls ?? new Set<string>();
  let toolCalls = 0;

  const system = buildWorkerSystem(task, ctx);
  const messages: CompletionRequest["messages"] = [
    { role: "user", content: buildUserTurn(task, ctx) },
  ];

  const deadline = Date.now() + ctx.wallClockMs;

  for (let round = 0; round < ctx.bus.list().length + 4; round++) {
    if (Date.now() > deadline)
      return { status: "failed", error: "wall clock exceeded", attempts: round, toolCalls };

    const text = await ctx.complete({
      model: ctx.model,
      system,
      messages: [...messages],
      maxTokens: 2048,
      temperature: 0.2,
      timeoutMs: Math.max(5_000, deadline - Date.now()),
      attribution: { thread_id: ctx.threadId, job_id: ctx.jobId, task_id: ctx.taskId },
    }).then((r) => r.text);
    ctx.onDelta?.(text);

    // Parse tool calls (native wire calls arrive via adapter; shim calls here).
    const shimCalls = parseShimCalls(text);
    if (shimCalls.length === 0) {
      // No tool calls → the reply IS the structured result. Validate via ladder.
      const outcome = await ladderValidate(text, task, ctx);
      return { ...outcome, attempts: round + 1, toolCalls };
    }

    for (const call of shimCalls) {
      const fingerprint = `${call.name}:${call.argsJson}`;
      toolCalls++;
      if (toolCalls > 8)
        return { status: "failed", error: "loop guard: 8 tool calls", attempts: round + 1, toolCalls };
      if (seen.has(fingerprint)) {
        messages.push({ role: "assistant", content: `<hk:call tool="${call.name}">${call.argsJson}</hk:call>` });
        messages.push({ role: "tool", toolName: call.name, content: "you already did that — use the previous result" });
        continue;
      }

      const push = (toolContent: string) => {
        messages.push({ role: "assistant", content: `<hk:call tool="${call.name}">${call.argsJson}</hk:call>` });
        messages.push({ role: "tool", toolName: call.name, content: toolContent });
      };
      const busCtx = { jobId: ctx.jobId, threadId: ctx.threadId, taskId: ctx.taskId, workDir: ctx.workDir };
      const busOpts = { hasRawUntrusted: task.kind === "reader", sourceFlagged: false };

      let res = await ctx.bus.run({ tool: call.name as never, input: call.args }, busCtx, busOpts);

      // Approval parking is INVISIBLE to the loop guard: the fingerprint is
      // burned only on a decisive outcome, and an approved receipt executes
      // INLINE in this same iteration — the model never has to repeat itself,
      // so the duplicate guard can never eat an approved action.
      if (!res.decision.go && "card" in res.decision && res.decision.card) {
        const { hashPayload } = require("@hivekit/tools") as typeof import("@hivekit/tools");
        const receipt = await ctx.onApprovalNeeded(res.decision.card, hashPayload(call.args));
        if (receipt) {
          res = await ctx.bus.run({ tool: call.name as never, input: call.args, receipt }, busCtx, busOpts);
        } else {
          seen.add(fingerprint);
          push("denied by operator — the action will not be taken; finish with a status result");
          continue;
        }
      }

      seen.add(fingerprint);
      if (res.decision.go) {
        const out = res.result?.output ?? JSON.stringify(res.result?.structured ?? {});
        // Raw untrusted output stays inside THIS reader's context (tagged);
        // findings exported from here are attested only via the result JSON.
        push(out.slice(0, 20_000));
      } else {
        const why = "code" in res.decision ? `${res.decision.code}: ${res.decision.message}` : "refused";
        push(`refused — ${why}`);
      }
    }
  }
  return { status: "failed", error: "tool-round budget exhausted", attempts: 8, toolCalls };
}

// ------------------------------------------------------------------ ladder glue

async function ladderValidate(
  rawText: string,
  task: PlanTask,
  ctx: TaskContext,
): Promise<{ status: TaskOutcome["status"]; result?: WorkerResult; error?: string }> {
  // The reply runTask already has IS attempt 1 — spending a second completion
  // to re-ask the same question would double-bill every worker turn.
  let firstRaw: string | null = rawText;
  const out = await runLadder<WorkerResult | null>({
    baseRequest: {
      model: ctx.model,
      system: buildWorkerSystem(task, ctx),
      messages: [{ role: "user", content: `${buildUserTurn(task, ctx)}\n\nYour previous reply (invalid):\n${rawText.slice(0, 2_000)}` }],
      maxTokens: 2048,
      temperature: 0.1,
      timeoutMs: 30_000,
      attribution: { thread_id: ctx.threadId, job_id: ctx.jobId, task_id: ctx.taskId },
    },
    buildAttempt: (_n, _arm, failures) => ({
      request: {
        model: ctx.model,
        system: buildWorkerSystem(task, ctx),
        messages: [
          { role: "user", content: buildUserTurn(task, ctx) },
          ...(failures.length
            ? [
                {
                  role: "user" as const,
                  content: `Your last result was invalid:\n${failures.map((f) => f.error).join("\n")}\nReturn corrected STRICT JSON only.`,
                },
              ]
            : []),
        ],
        maxTokens: 2048,
        temperature: 0.1,
        timeoutMs: 30_000,
        attribution: { thread_id: ctx.threadId, job_id: ctx.jobId, task_id: ctx.taskId },
      },
      input: null,
    }),
    call: async (req) => {
      if (firstRaw !== null) {
        const raw = firstRaw;
        firstRaw = null;
        return { value: coerceResult(raw), raw: "" };
      }
      return { value: coerceResult((await ctx.complete(req)).text), raw: "" };
    },
    validate: (value): ValidatorResult<WorkerResult | null> => {
      if (!value) return { ok: false, error: "result was not parseable as the result schema" };
      const v = WorkerResultSchema.safeParse(value);
      if (!v.success)
        return { ok: false, error: v.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
      if (v.data.status === "ok" && !v.data.success_claimed)
        return { ok: false, error: `status=ok but success_claimed=false — set success_claimed=true only if: ${task.success}` };
      return { ok: true };
    },
    fallbackFor: ctx.fallbackModel
      ? () => {
          const fb = ctx.fallbackModel();
          if (!fb) return null;
          const base: CompletionRequest = {
            model: fb,
            system: buildWorkerSystem(task, ctx),
            messages: [{ role: "user", content: buildUserTurn(task, ctx) }],
            maxTokens: 2048,
            temperature: 0.1,
            timeoutMs: 30_000,
            attribution: { thread_id: ctx.threadId, job_id: ctx.jobId, task_id: ctx.taskId },
          };
          return base;
        }
      : undefined,
  });

  if (out.value && out.value.status === "ok") return { status: "ok", result: out.value };
  if (out.value?.status === "blocked")
    return { status: "blocked", result: out.value, error: out.value.blockers.join("; ") };
  return { status: "failed", error: out.attempts.at(-1)?.error ?? "validation exhausted" };
}

function coerceResult(text: string): WorkerResult | null {
  const { parseTolerant } = require("@hivekit/models") as typeof import("@hivekit/models");
  const parsed = parseTolerant(text);
  return parsed.ok ? (parsed.value as WorkerResult) : null;
}

// ------------------------------------------------------------------ prompt pieces

export function buildWorkerSystem(task: PlanTask, ctx: TaskContext): string {
  const base = [
    ctx.instructions.trim(),
    "",
    "## Memory (retrieved)",
    ctx.memoryBlock || "(none)",
    "",
    "## Your role",
    `You execute ONE task: ${task.title}`,
    `Objective: ${task.objective}`,
    task.kind === "reader"
      ? "You are a READER: you fetch raw sources. Your context holds untrusted content — external sending tools do not exist for you. Return FINDINGS with citation locators (url#anchor); findings become attested data downstream."
      : "You are an ACTOR: you act on ATTESTED findings only. Never request raw page text; rely on findings given to you.",
    task.kind === "reader"
      ? ""
      : `\nYou have tools. Call them as TEXT, one per reply:\n<hk:call tool="name">\n{"json":"args"}\n</hk:call>\nWhen done, output STRICT JSON result:\n${RESULT_SCHEMA_JSON}`,
    task.kind === "reader"
      ? `\nWhen done, output STRICT JSON result:\n${RESULT_SCHEMA_JSON}`
      : "",
    `\nSuccess means: ${task.success}`,
    task.artifact ? `Write the artifact to: ${task.artifact}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return base;
}

function buildUserTurn(task: PlanTask, ctx: TaskContext): string {
  const findings = ctx.findings.length
    ? ctx.findings
        .map(
          (f) =>
            `- [from ${f.fromTask}] ${f.text.slice(0, 1_500)}\n  cites: ${f.citations.join(", ") || "-"}`,
        )
        .join("\n")
    : "(no prior findings)";
  return `Task inputs: ${(task.inputs ?? []).join(", ") || "(none)"}\n\nAttested findings from earlier tasks:\n${findings}`;
}

// ------------------------------------------------------------------ shim parsing

export interface ShimCall {
  name: string;
  argsJson: string;
  args: unknown;
}

/** Parse <hk:call tool="…">{json}</hk:call> — tolerant, never throws. */
export function parseShimCalls(text: string): ShimCall[] {
  const out: ShimCall[] = [];
  const re = /<hk:call\s+tool="([^"]+)"\s*>([\s\S]*?)<\/hk:call>/g;
  let m: RegExpExecArray | null;
  const { parseTolerant } = require("@hivekit/models") as typeof import("@hivekit/models");
  while ((m = re.exec(text)) !== null) {
    const parsed = parseTolerant(m[2] ?? "");
    out.push({
      name: m[1] ?? "",
      argsJson: (m[2] ?? "").trim(),
      args: parsed.ok ? parsed.value : {},
    });
  }
  return out;
}
