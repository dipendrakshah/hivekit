/**
 * Stream-03 helpers: canned SSE transports so every adapter test drives the
 * REAL request-building code path (buildOpenAiRequest/buildAnthropicRequest)
 * with zero network.
 */
import type { CompletionRequest } from "../src/types";

export function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${e}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** Full-capability OpenAI-compat profile: streams text deltas + native tool call + usage. */
export function fullCapabilityFetch(expectedTool = "publish_draft") {
  return async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    void _url;
    const sent = JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> };
    const hadNativeTools = Array.isArray(sent.tools) && sent.tools.length > 0;
    if (hadNativeTools) {
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "" } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: expectedTool, arguments: '{"path":"blog/x.md"}' } }] } }] }),
        JSON.stringify({ usage: { prompt_tokens: 42, completion_tokens: 17 } }),
      ]);
    }
    // plain text completion turn
    return sseResponse([
      JSON.stringify({ choices: [{ delta: { content: '{"status":"ok","artifact":"blog/x.md"}' } }] }),
      JSON.stringify({ usage: { prompt_tokens: 42, completion_tokens: 12 } }),
    ]);
  };
}

/**
 * Crippled profile: no native tools (answers with <hk:call> TEXT instead),
 * no system role (must be prepended), no JSON mode, weak recall. The handler
 * inspects the RENDERED request so this test exercises the real renderer.
 */
export function crippledModelFetch() {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      tools?: unknown[];
      messages: Array<{ role: string; content: string }>;
      response_format?: unknown;
    };
    const userText = body.messages.map((m) => m.content).join("\n");
    const firstIsUser = body.messages[0]?.role === "user";

    let replyText = "";
    if (body.tools && body.tools.length > 0) {
      // Realizing this branch means capabilities lied — native tools were offered.
      throw new Error("crippled model must never receive native tools");
    }
    if (/hk:call/.test(userText)) {
      replyText = `Thinking about it...\n<hk:call tool="publish_draft">\n{'path':'blog/x.md','title':'Hi'}\n</hk:call>\ndone marker`;
    } else {
      replyText = '{"status":"ok"}';
    }

    // Crippled profile constraints enforced against the WIRE BODY:
    if (!firstIsUser) throw new Error("crippled model got a non-user opening message");
    if (body.response_format) throw new Error("crippled model received json response_format");
    for (const m of body.messages) {
      if (m.role === "system") throw new Error("system role reached a no-system-role model");
      if (m.role === "tool") throw new Error("native tool result reached shim model");
    }

    return sseResponse([JSON.stringify({ choices: [{ delta: { content: replyText } }] })]);
  };
}

export const ATTRIB = { thread_id: "t", job_id: "j", task_id: null };

export const baseRequest = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: { provider: "openai_compat", id: "test/full" },
  system: "You are hivekit worker.",
  messages: [{ role: "user", content: "Publish the draft post now." }],
  maxTokens: 256,
  timeoutMs: 2000,
  attribution: ATTRIB,
  ...over,
});
