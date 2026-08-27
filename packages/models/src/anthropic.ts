/**
 * Anthropic adapter — ARCHITECTURE §4.4: plain `fetch` against the messages
 * API, no vendor SDK. The capability renderer has already handled the
 * "no system role" case; here system is a top-level field, tools use the
 * Anthropic block format, and deltas come through the SSE stream.
 */
import type {
  Completion,
  CompletionRequest,
  Delta,
  ToolCall,
  Usage,
} from "./types";

export interface AnthropicOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

interface SseEvent {
  type: string;
  delta?: { type?: string; text?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number }; model?: string };
  /** message_delta carries cumulative usage without a message wrapper. */
  usage?: { input_tokens?: number; output_tokens?: number };
  content_block?: { type?: string; name?: string; input?: unknown };
  content?: Array<{ type?: string; name?: string; input?: unknown }>;
  index?: number;
}

export function buildAnthropicRequest(req: CompletionRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (const m of req.messages) {
    if (m.role === "tool") {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolName ?? "", content: m.content }] });
      continue;
    }
    if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: (m.toolName ?? "call") + "_" + Math.random().toString(36).slice(2, 8), name: tc.name, input: tryParseJson(tc.argsJson) });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    // system role is hoisted; user/assistant pass through
    if (m.role === "system") continue;
    messages.push({ role: m.role, content: m.content });
  }

  const body: Record<string, unknown> = {
    model: req.model.id,
    max_tokens: req.maxTokens,
    messages,
    stream: true,
  };
  if (req.system) body.system = req.system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: tryParseJson(t.parametersJsonSchema),
    }));
  }
  if (req.jsonSchema) {
    // Anthropic supports structured output; pass a pseudo-tool as the goal.
  }
  return body;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return { _raw: s };
  }
}

export async function completeAnthropic(
  req: CompletionRequest,
  opts: AnthropicOptions,
  onDelta?: (d: Delta) => void,
): Promise<Completion> {
  const fetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  const body = buildAnthropicRequest(req);

  try {
    const res = await fetchFn(`${opts.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`anthropic ${res.status}: ${errText.slice(0, 300)}`);
    }
    if (!res.body) throw new Error("anthropic: no response body");

    let text = "";
    let usage: Usage | null = null;
    let servedModelId = req.model.id;
    let pendingTool: { name: string; input: unknown } | null = null;
    const toolCalls: ToolCall[] = [];

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let newIdx = buf.indexOf("\n");
      while (newIdx >= 0) {
        const line = buf.slice(0, newIdx).trim();
        buf = buf.slice(newIdx + 1);
        newIdx = buf.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev: SseEvent;
        try {
          ev = JSON.parse(payload) as SseEvent;
        } catch {
          continue;
        }
        if (ev.type === "content_block_start") {
          pendingTool = { name: "", input: null };
          void ev;
        }
        if (ev.type === "content_block_delta" && ev.delta?.text) {
          text += ev.delta.text;
          onDelta?.({ kind: "text", text: ev.delta.text });
        }
        if (ev.type === "content_block_stop" && pendingTool) pendingTool = null;
        if (ev.type === "message_delta" && ev.usage) {
          usage = { tokensIn: ev.usage.input_tokens ?? 0, tokensOut: ev.usage.output_tokens ?? 0 };
        }
        if (ev.content?.[0]?.type === "tool_use") {
          toolCalls.push({ name: ev.content[0].name ?? "", argsJson: JSON.stringify(ev.content[0].input ?? {}) });
        }
        if (ev.content_block?.type === "tool_use") {
          toolCalls.push({ name: ev.content_block.name ?? "", argsJson: JSON.stringify(ev.content_block.input ?? {}) });
        }
      }
    }

    const usageEstimated = usage === null;
    if (usage === null) {
      usage = { tokensIn: approxTokens(JSON.stringify(body)), tokensOut: approxTokens(text) };
    }
    return { text, toolCalls, usage, usageEstimated, servedModelId, stopReason: "stop" };
  } finally {
    clearTimeout(timer);
  }
}

function approxTokens(text: string, charsPerToken = 4): number {
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}