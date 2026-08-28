/**
 * Planner (§4.3 master loop) — turns the operator message into a validated
 * Plan: ≤8 tasks, each with an objective, inputs, expected artifact and a
 * SUCCESS SENTENCE the merge step will verify against.
 *
 * Code-first validation (FR-A6): the plan must parse as STRICT JSON, pass the
 * zod schema, and every task carries a success sentence — a plan without one
 * is rejected BEFORE any worker burns tokens. One strike at the planner; a
 * malformed second attempt surfaces a question card instead of guessing.
 */
import { z } from "zod";
import { parseTolerant, RepairCounter } from "@hivekit/models";
import type { CompletionRequest } from "@hivekit/models";

export const PlanTaskSchema = z.object({
  title: z.string().min(3).max(120),
  objective: z.string().min(5).max(600),
  inputs: z.array(z.string()).max(10).default([]),
  /** Expected artifact filename under the job dir, when the task produces one. */
  artifact: z.string().max(120).optional(),
  /** Verifiable completion sentence — the merge step checks worker output claims it. */
  success: z.string().min(8).max(300),
  /** Reader tasks fetch raw untrusted content; actor tasks act on ATTESTED findings only. */
  kind: z.enum(["reader", "actor"]).default("actor"),
});

export const PlanSchema = z.object({
  intent: z.string().min(3).max(300),
  tasks: z.array(PlanTaskSchema).min(1).max(8),
});

export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export const PLAN_JSON_SCHEMA = {
  name: "hivekit_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["intent", "tasks"],
    properties: {
      intent: { type: "string" },
      tasks: {
        type: "array",
        maxItems: 8,
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "objective", "success", "kind"],
          properties: {
            title: { type: "string" },
            objective: { type: "string" },
            inputs: { type: "array", items: { type: "string" } },
            artifact: { type: "string" },
            success: { type: "string" },
            kind: { type: "string", enum: ["reader", "actor"] },
          },
        },
      },
    },
  },
};

export interface PlannerDeps {
  instructions: string;
  memoryBlock: string;
  threadSummary: string;
  /** The single completion call — injected so tests fake it deterministically. */
  complete: (req: CompletionRequest) => Promise<{ text: string; model: string }>;
  model: { provider: import("@hivekit/models").ProviderId; id: string };
  attribution: { thread_id: string; job_id: string; task_id: string | null };
}

export type PlanOutcome =
  | { ok: true; plan: Plan; repairs: string }
  | { ok: false; error: string; rawText: string };

export function planSystemPrompt(deps: PlannerDeps): string {
  return [
    deps.instructions.trim(),
    "",
    "## Memory (retrieved — never the whole file)",
    deps.memoryBlock || "(none)",
    "",
    "## Thread context",
    deps.threadSummary,
    "",
    "## Your role",
    "You are the MASTER. Plan only — never execute. Return STRICT JSON, no prose:",
    '  {"intent": "...", "tasks": [{"title","objective","inputs":["..."],"artifact","success","kind"}]}',
    "- kind=reader tasks FETCH sources and return findings; kind=actor tasks consume findings.",
    "- Every task's `success` must be a checkable sentence about its OUTPUT, not its effort.",
    "- Web-facing work is two hops: reader tasks hold raw page text (no send tools); actor tasks act only on findings.",
    '- Conversational asks (greetings, questions, "reply with X") need ONE actor task — do not invent reader/fetch tasks when no sources are named.',
    "- Never more than 8 tasks. Do not plan tool calls you have not been granted.",
  ].join("\n");
}

export async function planJob(userMessage: string, deps: PlannerDeps): Promise<PlanOutcome> {
  const system = planSystemPrompt(deps);
  const req: CompletionRequest = {
    model: deps.model,
    system,
    messages: [{ role: "user", content: userMessage }],
    jsonSchema: PLAN_JSON_SCHEMA,
    maxTokens: 2048,
    temperature: 0.1,
    timeoutMs: 30_000,
    attribution: deps.attribution,
  };

  // Two strikes at the planner: exact validator error appended on retry (FR-A6 lite).
  let lastError = "";
  let lastRaw = "";
  for (let strike = 0; strike < 2; strike++) {
    const attemptReq: CompletionRequest = lastError
      ? {
          ...req,
          messages: [
            ...req.messages,
            { role: "assistant", content: lastRaw },
            {
              role: "user",
              content: `<plan-validation-result>\n${lastError}\n</plan-validation-result>\nReturn corrected STRICT JSON only.`,
            },
          ],
        }
      : req;
    const { text, model } = await deps.complete(attemptReq);
    lastRaw = text;
    void model;
    const counter = new RepairCounter();
    const parsed = parseTolerant(text, counter);
    if (!parsed.ok) {
      lastError = `reply was not parseable as JSON (${parsed.error})`;
      continue;
    }
    const verdict = PlanSchema.safeParse(parsed.value);
    if (!verdict.success) {
      lastError = verdict.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
        .slice(0, 400);
      continue;
    }
    const plan = verdict.data;
    const missingSuccess = plan.tasks.filter((t) => !/\.$|[a-z]$/.test(t.success.trim()));
    if (missingSuccess.length) {
      lastError = `tasks missing a usable success sentence: ${missingSuccess.map((t) => t.title).join(", ")}`;
      continue;
    }
    return { ok: true, plan, repairs: JSON.stringify(counter.counts) };
  }
  return { ok: false, error: lastError || "planner produced no parseable plan", rawText: lastRaw };
}
