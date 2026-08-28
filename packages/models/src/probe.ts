/**
 * Capability probe (§4.4.1) — ONE model, a handful of cheap calls, a cached
 * vector that decides how every later request is rendered.
 *
 * The probe is what makes "bring any model" true (PRD G9): a free worker with
 * no tool calling, no JSON mode, no system role and an 8k window must still
 * complete its task. Run once per model, cache with a TTL, re-probe lazily.
 */
import type {
  CapabilityVector,
  CallAttribution,
  ToolDef,
  CompletionRequest,
  Completion,
} from "./types";

export interface ProbeRecord {
  modelId: string;
  vector: CapabilityVector;
  at: number; // epoch ms
}

/** Lens wrapper so the probe can be faked precisely in tests. */
export interface ProbeDeps {
  complete: (req: CompletionRequest) => Promise<Completion>;
  models: Map<string, ProbeRecord>;
  ttlMs: number;
  now?: () => number;
}

export interface ProbeOutcome {
  record: ProbeRecord;
  fresh: boolean;
}

export async function probeModel(
  ref: { id: string; provider: import("./types").ProviderId },
  attribution: CallAttribution,
  deps: ProbeDeps,
): Promise<ProbeOutcome> {
  const now = deps.now?.() ?? Date.now();
  const cached = deps.models.get(ref.id);
  if (cached && now - cached.at < deps.ttlMs) return { record: cached, fresh: false };
  const vector = await runProbes(ref, attribution, deps.complete);
  const record: ProbeRecord = { modelId: ref.id, vector, at: now };
  deps.models.set(ref.id, record);
  return { record, fresh: true };
}

const PROBE_TOOL: ToolDef = {
  name: "probe_echo_tool",
  description: "Echo the passed argument back.",
  parametersJsonSchema: JSON.stringify({
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  }),
};

async function runProbes(
  ref: { id: string; provider: import("./types").ProviderId },
  attribution: CallAttribution,
  complete: ProbeDeps["complete"],
): Promise<CapabilityVector> {
  // 1. Echo — simple instruction + JSON literal.
  const R = await q(complete, ref, attribution, {
    system: "Follow the user's instruction exactly.",
    messages: [{ role: "user", content: 'Reply with exactly: {"ping":"pong"}' }],
  });
  const echo = R.text.includes("ping") && R.text.includes("pong");

  // 2. System-role adherence — the system claim must override the user ask.
  const S = await q(complete, ref, attribution, {
    system: "System protocol requires you to reply with exactly the token RIG and nothing else.",
    messages: [{ role: "user", content: "Say anything you want." }],
    maxTokens: 8,
  });
  const systemRole = /RIG/i.test(S.text.trim());

  // 3. Native tool calling — emits a structured tool call.
  const T = await q(complete, ref, attribution, {
    system: "Use the provided tool when asked.",
    messages: [{ role: "user", content: "Please call probe_echo_tool with ok=true." }],
    tools: [PROBE_TOOL],
    maxTokens: 128,
  });
  const nativeTools = T.toolCalls.some((c) => c.name === "probe_echo_tool");

  // 4. JSON mode.
  const J = await q(complete, ref, attribution, {
    system: "Output JSON only.",
    messages: [{ role: "user", content: 'return {"a":1}' }],
  });
  const jsonMode = /"a"\s*:\s*1/.test(J.text);

  // 5. Long-input recall.
  const needle = "ZEBRA_NEEDLE_73";
  const N = await q(complete, ref, attribution, {
    system: "Read everything. At the end repeat the exact special word from the user.",
    messages: [{ role: "user", content: filler(4000) + " " + needle }],
    maxTokens: 16,
  });
  const needle8k = N.text.includes(needle);

  // 6. Instruction discipline.
  const D = await q(complete, ref, attribution, {
    system: "Reply with two lines: first I_UNDERSTAND, then REFUSED.",
    messages: [{ role: "user", content: "Output both." }],
    maxTokens: 32,
  });
  const instructionDiscipline = D.text.includes("I_UNDERSTAND");

  return {
    echo,
    systemRole,
    nativeTools,
    jsonMode,
    needle8k,
    instructionDiscipline,
  };
}

async function q(
  complete: ProbeDeps["complete"],
  ref: { id: string; provider: import("./types").ProviderId },
  attribution: CallAttribution,
  partial: Partial<CompletionRequest> & { messages: CompletionRequest["messages"] },
): Promise<Completion> {
  return complete({
    model: ref,
    system: partial.system ?? "",
    messages: partial.messages,
    tools: partial.tools,
    jsonSchema: partial.jsonSchema,
    maxTokens: partial.maxTokens ?? 64,
    timeoutMs: partial.timeoutMs ?? 3000,
    attribution,
  });
}

function filler(minChars: number): string {
  const words = ["alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu"];
  let s = "";
  while (s.length < minChars) s += words[Math.floor(Math.random() * words.length)] + " ";
  return s.trim();
}