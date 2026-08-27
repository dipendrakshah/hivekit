/**
 * Capability renderer (§4.4.1) — the heart of "bring any model".
 *
 * The SAME logical request is lowered per capability:
 *   no system role  -> system text prepended to the first user message
 *   native tools    -> left as-is for the adapter
 *   no native tools -> tool descriptions injected into the prompt and the
 *                      model signals calls as <hk:call name="…">…</hk:call>
 *                      (parsed, repaired, counted here — see json.ts)
 *   jsonMode        -> jsonSchema passed to the provider
 *   no jsonMode     -> schema inlined with ONE worked example
 *   small window    -> nothing here; the caller sends fewer inputs
 */
import type {
  CompletionRequest,
  ConversationMessage,
  CapabilityVector,
  ToolDef,
  ToolCall,
} from "./types";
import { RepairCounter, parseTolerant } from "./json";

export const HK_CALL_RE = /<hk:call\s+tool="([^"]+)"\s*>([\s\S]*?)<\/hk:call>/g;

/** Inject tool descriptions into the system prompt for text-shim models. */
export function renderToolPrompt(system: string, tools: ToolDef[]): string {
  if (!tools.length) return system;
  const list = tools
    .map((t) => `- \`${t.name}\`: ${t.description}\n  Schema: ${t.parametersJsonSchema}`)
    .join("\n");
  return (
    `${system}\n\n` +
    `You have tools you call as TEXT, one per reply, in this exact form:\n` +
    `<hk:call tool="name">\n{"json":"args"}\n</hk:call>\n` +
    `After the result arrives, continue. Finish a task with <hk:final>…</hk:final>.\n` +
    `Available tools:\n${list}`
  );
}

/** Extract + repair <hk:call> tool calls from a worker reply. */
export function parseHkCalls(text: string, counter?: RepairCounter): ToolCall[] {
  const calls: ToolCall[] = [];
  HK_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HK_CALL_RE.exec(text)) !== null) {
    const name = m[1] as string;
    const argsRaw = m[2] as string;
    const parsed = parseTolerant(argsRaw, counter);
    calls.push({
      name,
      argsJson: parsed.ok ? JSON.stringify(parsed.value) : argsRaw,
    });
  }
  return calls;
}

export interface RenderOptions {
  caps: Pick<
    CapabilityVector,
    "systemRole" | "nativeTools" | "jsonMode" | "needle8k"
  >;
}

/**
 * Lower a request to what the target model can honor. Pure + deterministic so
 * the renderer is exhaustively testable without any wire I/O.
 */
export function renderForCapability(
  req: CompletionRequest,
  caps: CapabilityVector,
): CompletionRequest {
  let system = req.system;
  let messages: ConversationMessage[] = req.messages.map((m) => ({ ...m }));

  // No system role -> prepend system text to the first user turn.
  if (!caps.systemRole && system) {
    const firstUser = messages.findIndex((m) => m.role === "user");
    if (firstUser >= 0) {
      const first = messages[firstUser];
      if (first) {
        messages[firstUser] = {
          ...first,
          content: `<system>\n${system}\n</system>\n\n${first.content}`,
        };
      }
    } else {
      messages.unshift({ role: "user", content: `<system>\n${system}\n</system>` });
    }
    system = "";
  }

  // No native tools -> describe them in the prompt; the model emits <hk:call>.
  let tools = req.tools;
  if (tools && !caps.nativeTools) {
    system = renderToolPrompt(system, tools);
    tools = [];
  }

  // No jsonMode -> inline the schema with one worked example and strip it.
  let jsonSchema = req.jsonSchema;
  if (req.jsonSchema && !caps.jsonMode) {
    system = inlineJson(system, req.jsonSchema, req.messages);
    jsonSchema = undefined;
  }

  // Ordering matters: the tool shim may have RE-CREATED a system string
  // after the no-system-role lowering above consumed the original one.
  // Re-run the prepend so a model without a system channel NEVER receives
  // top-level system text — whatever produced it.
  if (!caps.systemRole && system) {
    const firstUserIdx = messages.findIndex((m) => m.role === "user");
    const sysText = `<system>\n${system}\n</system>`;
    if (firstUserIdx >= 0) {
      const first = messages[firstUserIdx];
      if (first) {
        // Idempotent-ish merge: tool-prompt block must lead the turn content.
        messages[firstUserIdx] = { ...first, content: `${sysText}\n\n${first.content}` };
      }
    } else {
      messages.unshift({ role: "user", content: sysText });
    }
    system = "";
  }

  return { ...req, system, messages, tools, jsonSchema };
}

function inlineJson(
  system: string,
  schemaConstraint: NonNullable<CompletionRequest["jsonSchema"]>,
  _messages: ConversationMessage[],
): string {
  const example = JSON.stringify(schemaConstraint.schema);
  return (
    `${system}\n\n` +
    `Output STRICT JSON matching this schema (no prose around it):\n` +
    `Schema: ${example}\n` +
    `Worked example: ${example}\n\n`
  );
}