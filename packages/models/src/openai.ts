/**
 * OpenAI-compatible adapter (OpenRouter, Groq, Together, Fireworks, Ollama,
 * LM Studio, custom base URLs) — ARCHITECTURE §4.4.
 *
 * Plain `fetch` against /chat/completions, no vendor SDK, streaming passed
 * through as normalized Delta chunks. Usage comes from the final chunk or the
 * non-stream response; when a provider sends none the gateway estimates and
 * flags `usageEstimated` (never silently blend a guess into a measurement).
 */
import type {
  Completion,
  CompletionRequest,
  Delta,
  ToolCall,
  Usage,
} from "./types";

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

function sseBody(res: ReadableStream<Uint8Array> | null, onJson: (o: unknown) => void): Promise<void> {
  if (!res) return Promise.resolve();
  const reader = res.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            onJson(JSON.parse(payload));
          } catch {
            /* skip malformed SSE data line */
          }
        }
      }
    }
  })();
}

/** Turn a normalized request into the OpenAI wire body. */
export function buildOpenAiRequest(req: CompletionRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "tool") {
      messages.push({ role: "tool", tool_call_id: m.toolName ?? "", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const base: Record<string, unknown> = { role: "assistant", content: m.content };
      if (m.toolCalls?.length) {
        base.tool_calls = m.toolCalls.map((tc, i) => ({
          id: `${m.toolName ?? "call"}_${i}`,
          type: "function",
          function: { name: tc.name, arguments: tc.argsJson },
        }));
      }
      messages.push(base);
      continue;
    }
    messages.push({ role: m.role, content: m.content });
  }

  const body: Record<string, unknown> = {
    model: req.model.id,
    messages,
    max_tokens: req.maxTokens,
    stream: true,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: JSON.parse(t.parametersJsonSchema) as unknown },
    }));
  }
  if (req.jsonSchema) {
    body.response_format = { type: "json_schema", json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema } };
  }
  return body;
}

export async function completeOpenAiCompat(
  req: CompletionRequest,
  opts: OpenAiCompatOptions,
  onDelta?: (d: Delta) => void,
): Promise<Completion> {
  const fetchFn = opts.fetchFn ?? fetch;
  const body = buildOpenAiRequest(req);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);

  try {
    const res = await fetchFn(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`openai-compat ${res.status}: ${errText.slice(0, 300)}`);
    }
    if (!res.body) throw new Error("openai-compat: no response body");

    let text = "";
    const toolCalls: ToolCall[] = [];
    let usage: Usage | null = null;
    let servedModelId = req.model.id;

    await sseBody(res.body, (json) => {
      const ch = json as {
        model?: string;
        choices?: Array<{
          delta?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (ch.model) servedModelId = ch.model;
      const delta = ch.choices?.[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        onDelta?.({ kind: "text", text: delta.content });
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const fn = tc.function;
          if (!fn) continue;
          let call = toolCalls.find((c) => c.name === fn.name && fn.name);
          if (!call) {
            call = { name: fn.name ?? "", argsJson: "" };
            toolCalls.push(call);
          }
          call.argsJson += fn.arguments ?? "";
        }
      }
      if (ch.usage) usage = { tokensIn: ch.usage.prompt_tokens ?? 0, tokensOut: ch.usage.completion_tokens ?? 0 };
    });

    const usageEstimated = usage === null;
    if (usage === null) {
      usage = { tokensIn: approxTokens(JSON.stringify(body)), tokensOut: approxTokens(text) };
    }
    return {
      text,
      toolCalls: toolCalls.filter((c) => c.name),
      usage,
      usageEstimated,
      servedModelId,
      stopReason: "stop",
    };
  } finally {
    clearTimeout(timer);
  }
}

function approxTokens(text: string, charsPerToken = 4): number {
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}