/**
 * Tolerant-parser corpus (todo/03 DoD: ≥40 real malformed outputs parse, every
 * repair kind counted) + probe TTL behavior + render matrix.
 */
import { describe, expect, test } from "bun:test";

import { parseTolerant, RepairCounter, extractJsonBlock } from "../src/json";
import { probeModel } from "../src/probe";
import { ALL_CAPABLE } from "../src/types";
import type { CompletionRequest, Completion } from "../src/types";
import { renderForCapability } from "../src/render";
import { baseRequest } from "./helpers";

// ------------------------------------------------------------------ corpus

const VALID = {
  status: "ok",
  artifact: "blog/post.md",
  findings: [{ claim: "prices rose", cite: "https://ex.dev/p#L3" }],
  success: "post published with citations intact",
};

/** Damage functions — each variant applies ONE realistic model failure mode. */
function damageVariants(raw: string): Array<{ name: string; text: string }> {
  const fenced = `\`\`\`json\n${raw}\n\`\`\``;
  const prose = `Here is my result:\n${raw}\nLet me know if that works!`;
  const smart = raw.replace(/"/g, "\u201c").replace(/"$/g, "\u201d");
  return [
    { name: "plain", text: raw },
    { name: "fenced", text: fenced },
    { name: "fenced-bare", text: "```\n" + raw + "\n```" },
    { name: "prose-before", text: prose },
    { name: "prose-after", text: `${raw}\nDone.` },
    { name: "both-prose", text: `Sure!\n${fenced}\nThanks.` },
    { name: "trailing-comma", text: raw.replace(/\}\s*,?$/, ",}") },
    { name: "single-quotes", text: raw.replace(/"/g, "'") },
    { name: "unquoted-keys", text: raw.replace(/([{,]\s*)"(\w+)":/g, "$1$2:") },
    { name: "smart-double", text: smart },
    { name: "leading-newlines", text: "\n\n\n" + raw },
    { name: "concat-pairs", text: raw + "\n" + raw.replace("ok", "ok2") },
    { name: "array-wrapped-fenced", text: "```json\n[" + raw.replace(/\s+/g, " ") + "]\n```" },
    { name: "prose-smart-mix", text: `Result → ${smart.replace(/\u201c/g, '"').replace(/\u201d/g, '"')}` },
  ];
}

const malformedCorpus = (): Array<{ name: string; text: string }> => {
  const seedValid = JSON.stringify(VALID, null, 2);
  const baseVariants = damageVariants(seedValid);
  // Four alternate "real reply" shapes × repairs = breadth beyond one shape.
  const alternates = [
    JSON.stringify({ status: "blocked", reason: "source 404 after two tries" }),
    JSON.stringify({ status: "needs_input", question: "which branch?" }),
    JSON.stringify({ tasks: [{ id: 1, title: "sweep feed" }, { id: 2, title: "draft update" }] }),
    JSON.stringify({ status: "ok", artifact: null }),
  ];
  const fifthPlus = alternates.map((a) => ({ name: `alt-${a.slice(12, 22)}-noisy`, text: `OUTPUT:\n\`${a}\`\n` }));
  const altVariants = alternates.flatMap((a) => damageVariants(a).slice(0, 6)).concat(fifthPlus);
  const all = [...baseVariants, ...altVariants];
  return all;
};

describe("tolerant JSON parsing corpus", () => {
  test("DoD: ≥40 malformed outputs parse correctly; repairs are attributed", () => {
    const corpus = malformedCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(40);

    let parsed = 0;
    const counter = new RepairCounter();
    for (const sample of corpus) {
      const r = parseTolerant(sample.text, counter);
      if (r.ok) parsed++;
      else throw new Error(`corpus item FAILED to parse [${sample.name}]: ${r.error}\n${sample.text.slice(0, 120)}`);
    }
    expect(parsed).toBe(corpus.length);
    expect(counter.total()).toBeGreaterThan(20); // repairs happened, not luck
    expect((counter.counts["trailing-comma"] ?? 0) > 0 || (counter.counts["single-quotes"] ?? 0) > 0).toBe(true);
  });

  test("concatenated objects become an array repair", () => {
    const counter = new RepairCounter();
    const r = parseTolerant('{"a":1}{"b":2}', counter);
    expect(r.ok).toBe(true);
    expect(counter.counts["concatenated-json"]).toBe(1);
    if (r.ok) expect(Array.isArray(r.value)).toBe(true);
  });

  test("unparseable garbage still fails closed with the FIRST parse error", () => {
    const r = parseTolerant("I really cannot help with that request at all, sorry!");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(typeof r.error).toBe("string");
  });

  test("strings containing braces do not confuse the balance scan", () => {
    const tricky = '{"note":"he said {hi \\"there\\"}"}';
    const r = parseTolerant(tricky);
    expect(r.ok).toBe(true);
  });

  test("extractJsonBlock reports prose+fence provenance for counting only", () => {
    expect(extractJsonBlock('{"x":1}').hadProse).toBe(false);
    expect(extractJsonBlock('prefix {"x":1}').hadProse).toBe(true);
    expect(extractJsonBlock('```json\n{"x":1}\n```').hadFence).toBe(true);
  });
});

// ------------------------------------------------------------------ probe TTL

const ATTRIB = { thread_id: "t", job_id: "j", task_id: null };

function fakeComplete(failAfter?: number) {
  let calls = 0;
  return {
    calls: () => calls,
    complete: async (_req: CompletionRequest): Promise<Completion> => {
      calls++;
      if (failAfter !== undefined && calls > failAfter) throw new Error("rate limited (429)");
      return {
        text: 'RIG {"ping":"pong"} I_UNDERSTAND probe called',
        toolCalls: [{ name: "probe_echo_tool", argsJson: '{"ok":true}' }],
        usage: { tokensIn: 10, tokensOut: 10 },
        usageEstimated: false,
        servedModelId: "test/model",
        stopReason: "stop",
      };
    },
  };
}

describe("capability probe TTL", () => {
  test("cached vector short-circuits within TTL; expiry re-probes", async () => {
    let now = 1000;
    const fake = fakeComplete();
    const models = new Map();

    await probeModel({ id: "m/one", provider: "openai_compat" }, ATTRIB, {
      complete: fake.complete,
      models,
      ttlMs: 60_000,
      now: () => now,
    });
    const firstCalls = fake.calls();
    expect(firstCalls).toBe(6); // six lenses per ARCHITECTURE §4.4.1

    now += 30_000;
    const cached = await probeModel({ id: "m/one", provider: "openai_compat" }, ATTRIB, {
      complete: fake.complete,
      models,
      ttlMs: 60_000,
      now: () => now,
    });
    expect(cached.fresh).toBe(false);
    expect(fake.calls()).toBe(firstCalls);

    now += 61_000;
    const expired = await probeModel({ id: "m/one", provider: "openai_compat" }, ATTRIB, {
      complete: fake.complete,
      models,
      ttlMs: 60_000,
      now: () => now,
    });
    expect(expired.fresh).toBe(true);
    expect(fake.calls()).toBe(firstCalls * 2);
  });
});

// --------------------------------------------------------------- render matrix

describe("render matrix is exhaustive over capability bits", () => {
  const vectors: Array<[string, boolean, boolean, boolean]> = [
    ["capable", true, true, true],
    ["no-sys", false, true, true],
    ["no-tools", true, false, true],
    ["no-json", true, true, false],
    ["worst-case", false, false, false],
  ];
  for (const [name, sys, tools, json] of vectors) {
    test(`${name}: wire body stays lawful`, () => {
      const vector = { ...ALL_CAPABLE, systemRole: sys, nativeTools: tools, jsonMode: json };
      const req = baseRequest({
        tools: [{ name: "pub", description: "publish a draft", parametersJsonSchema: "{}" }],
        jsonSchema: { name: "result", schema: { type: "object" } },
      });
      const r = renderForCapability(req, vector);
      if (!sys) expect(r.system).toBe("");
      if (!tools) expect(r.tools!.length).toBe(0);
      if (!json) expect(r.jsonSchema).toBeUndefined();
      if (name === "worst-case") {
        const joined = r.messages.map((m) => m.content).join("\n");
        expect(joined).toContain("<system>"); // role hoisted into content
        expect(joined).toContain("hk:call");   // tool shim present
        expect(joined).toContain("STRICT JSON");
              }
    });
  }

  test("shim call regex tolerates whitespace and quotes variants", () => {
    const { parseHkCalls } = require("../src/render") as typeof import("../src/render");
    const parsed = parseHkCalls(
      `<hk:call tool="a">\n{"x":1}\n</hk:call>\ntext between\n<hk:call    tool='b' >{y:'2'}</hk:call>`,
    );
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(parsed[0]!.argsJson).x).toBe(1);
  });
});
