/**
 * G9 headline test (PRD): THE SAME JOB completes against a full-capability
 * model AND a crippled model — no native tools, no JSON mode, no system role.
 * Driven through gatewayComplete so probe→render→adapter→spend all run for real.
 */
import { describe, expect, test } from "bun:test";

import { gatewayComplete } from "../src/gateway";
import { SpendRecorder } from "../src/spend";
import type { Catalog } from "../src/catalog";
import { ALL_CAPABLE } from "../src/types";
import { parseHkCalls } from "../src/render";
import {
  baseRequest,
  fullCapabilityFetch,
  crippledModelFetch,
} from "./helpers";

const catalog: Catalog = new Map(
  Object.entries({
    "openai_compat:test/full": { provider: "openai_compat", id: "test/full", context: 128000, priceInPerM: 1.0, priceOutPerM: 2.0, modality: null, stealth: false },
    "openai_compat:test/weak": { provider: "openai_compat", id: "test/weak", context: 8192, priceInPerM: 0, priceOutPerM: 0, modality: null, stealth: true },
  }),
);

function opts(fetchFn: typeof fetch, modelId: string) {
  const capabilities = new Map();
  // Pre-seed so gatewayComplete doesn't re-probe with this stubbed transport;
  // probe behavior itself is covered in capability.test.ts.
  if (/full/.test(modelId)) {
    capabilities.set("test/full", { modelId: "test/full", vector: ALL_CAPABLE, at: Date.now() });
  } else {
    capabilities.set("test/weak", {
      modelId: "test/weak",
      vector: { echo: true, systemRole: false, nativeTools: false, jsonMode: false, needle8k: false, instructionDiscipline: true },
      at: Date.now(),
    });
  }
  return {
    registry: () => ({ provider: "openai_compat" as const, baseUrl: "http://stub", apiKey: "sk-test-not-real" }),
    catalog,
    spend: new SpendRecorder(),
    capabilityTtlMs: 3_600_000,
    capabilities,
    fetchFn,
  };
}

const TOOL_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: { path: { type: "string" }, title: { type: "string" } },
  required: ["path"],
});

describe("G9 — one job, two radically different models", () => {
  test("full-capability model: native tool call round-trips through the gateway", async () => {
    const o = opts(fullCapabilityFetch(), "test/full");
    const out = await gatewayComplete(
      baseRequest({
        tools: [{ name: "publish_draft", description: "publish", parametersJsonSchema: TOOL_JSON_SCHEMA }],
        jsonSchema: undefined,
      }),
      o,
    );
    expect(out.completion.toolCalls[0]?.name).toBe("publish_draft");
    expect(out.completion.usageEstimated).toBe(false); // usage arrived from the wire
    expect(out.caps.systemRole).toBe(true);
    // spend row recorded with requested == served
    const rows = o.spend.rows;
    expect(rows.length).toBe(1);
    expect(rows[0]!.model_requested).toBe("test/full");
    expect(rows[0]!.usd).toBeGreaterThan(0);
  });

  test("crippled model: same request runs via text shim and <hk:call>, zero capability assumptions", async () => {
    const o = opts(crippledModelFetch(), "test/weak");
    // THE SAME JOB as the capable case — tools included; only the RENDERING differs.
    const out = await gatewayComplete(
      baseRequest({
        model: { provider: "openai_compat", id: "test/weak" },
        tools: [{ name: "publish_draft", description: "publish", parametersJsonSchema: TOOL_JSON_SCHEMA }],
      }),
      o,
    );

    // The wire never saw a tool array or response_format (handler throws otherwise).
    // Extract + repair the shim call — single-quote JSON gets repaired:
    const calls = parseHkCalls(out.completion.text);
    expect(calls.length).toBe(1);
    const args = JSON.parse(calls[0]!.argsJson) as Record<string, unknown>;
    expect(args.path).toBe("blog/x.md");

    // weak model flagged in notes; spend shows requested test/weak served test/weak
    expect(out.notes.join(" ")).toMatch(/weak/);
    expect(o.spend.rows[0]!.usageEstimated).toBe(true); // crippled fixture sends no usage
  });

  test("spend parity: every gateway call costs exactly one row, across fallback too", async () => {
    // Primary transport 500s → retryable → fallback model answers.
    let primaryCalls = 0;
    const failingThenFallback = (async (url, init) => {
      void url;
      primaryCalls++;
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (body.model === "test/primary") {
        return new Response("upstream exploded", { status: 500 });
      }
      return sseResponse([
        JSON.stringify({ model: "test/fallback", choices: [{ delta: { content: '"ok"' } }] } as object),
      ]);
    }) as typeof fetch;

    const capStore = new Map([
      ["test/primary", { modelId: "test/primary", vector: ALL_CAPABLE, at: Date.now() }],
      ["test/fallback", { modelId: "test/fallback", vector: ALL_CAPABLE, at: Date.now() }],
    ]);
    catalog.set("openai_compat:test/primary", { provider: "openai_compat", id: "test/primary", context: 99999, priceInPerM: 3, priceOutPerM: 4, modality: null, stealth: false });

    const spend = new SpendRecorder();
    const out = await gatewayComplete(baseRequest({ model: { provider: "openai_compat", id: "test/primary" } }), {
      registry: () => ({ provider: "openai_compat", baseUrl: "http://stub", apiKey: "sk-ci-fake" }),
      catalog,
      spend,
      capabilityTtlMs: 3_600_000,
      capabilities: capStore,
      fallbackFor: () => ({ provider: "openai_compat", id: "test/fallback" }),
      fetchFn: failingThenFallback,
    });

    expect(out.fallbackUsed).toBe(true);
    expect(out.completion.servedModelId).toBe("test/fallback");
    expect(spend.rows.length).toBe(1); // ONE row per logical completion
    expect(spend.rows[0]!.model_requested).toBe("test/primary");
    expect(spend.rows[0]!.model_served).toBe("test/fallback"); // the swap is VISIBLE
    expect(primaryCalls).toBe(2); // attempted primary once + fallback once
  });
});

import { sseResponse } from "./helpers";
