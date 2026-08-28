/**
 * @hivekit/models — core types.
 *
 * The governing idea (§4.4): ONE logical request, MANY wire renderings. A
 * capability vector decides how the same conversation is expressed to a given
 * model — native tools or a text shim, JSON mode or an inlined schema, system
 * role or a prepended first turn. Nothing downstream knows which form ran;
 * spend and validation operate on normalized results.
 *
 * Every completion carries attribution as a REQUIRED constructor parameter:
 * an unattributed call is a compile error, not a convention (ARCH §4.4).
 */

export interface CallAttribution {
  thread_id: string;
  job_id: string;
  task_id: string | null;
}

export type ProviderId =
  | "openai_compat" // OpenRouter, Groq, Together, Fireworks, Ollama, custom base URLs
  | "anthropic"
  | "zai"; // Z.ai GLM — OpenAI-compatible (adapter dispatch falls through to openai_compat)
// Google optional later — deliberately absent until a PRD asks for it.

export interface ModelRef {
  provider: ProviderId;
  /** Raw slug as configured (`stealth/ox-alpha`, `anthropic/claude-…`). */
  id: string;
}

/** Capabilities discovered by probe.ts — one bit per rendering decision. */
export interface CapabilityVector {
  echo: boolean;
  systemRole: boolean;
  nativeTools: boolean;
  jsonMode: boolean;
  needle8k: boolean;
  instructionDiscipline: boolean;
}

export const ALL_CAPABLE: CapabilityVector = {
  echo: true,
  systemRole: true,
  nativeTools: true,
  jsonMode: true,
  needle8k: true,
  instructionDiscipline: true,
};

export function isCrippled(c: CapabilityVector): boolean {
  return !c.systemRole || !c.nativeTools || !c.jsonMode || !c.needle8k;
}

/** A simple provider-neutral conversation turn. */
export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant-side native tool calls (openai-compat), normalized. */
  toolCalls?: Array<{ name: string; argsJson: string }>;
  /** For role:"tool" — which prior call this answers. */
  toolName?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parametersJsonSchema: string; // JSON-schema text; rendered per capability
}

export interface JsonSchemaConstraint {
  name: string;
  schema: unknown;
}

/** The post-rendering request an adapter understands (no capability variance). */
export interface CompletionRequest {
  model: ModelRef;
  system: string;
  messages: ConversationMessage[];
  tools?: ToolDef[];
  jsonSchema?: JsonSchemaConstraint;
  temperature?: number;
  maxTokens: number;
  timeoutMs: number;
  /** REQUIRED — an unattributed call must not compile. */
  attribution: CallAttribution;
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
}

export interface ToolCall {
  name: string;
  argsJson: string;
}

export interface Completion {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** True when usage was estimated locally because the provider sent none. */
  usageEstimated: boolean;
  /** Which concrete model answered — gateways substitute, so record BOTH. */
  servedModelId: string;
  stopReason: "stop" | "tool_call" | "length" | "error" | "aborted";
}

/** Normalized streaming deltas — adapters translate SSE into these. */
export type Delta =
  | { kind: "text"; text: string }
  | { kind: "usage"; usage: Usage }
  | { kind: "served"; modelId: string };

export interface CompletionHooks {
  onDelta?: (d: Delta) => void;
}
