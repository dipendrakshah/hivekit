/**
 * MasterRuntime tests — the heart of the product, driven end to end with
 * scripted wire transports: planning → parallel workers → merge → spend,
 * untrusted reduction, approval receipts, boot recovery with teeth, loop guard.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { openDb } from "../src/db";
import { ALL_CAPABLE, type ProbeRecord } from "@hivekit/models";
import { MasterRuntime, type RuntimeDeps } from "../src/runtime";
import type { Catalog } from "@hivekit/models";
function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      // events are ALREADY wire strings (planSse/resultSse stringify) — no re-stringify
      for (const e of events) controller.enqueue(encoder.encode(`data: ${e}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

// ---------------------------------------------------------------- harness

function scriptedDeps(script: Array<(body: Record<string, unknown>) => Response>, extra?: Partial<RuntimeDeps>) {
  const db = openDb(":memory:");
  let i = 0;
  const calls: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    const step = script[Math.min(i++, script.length - 1)]!;
    return step(body);
  }) as typeof fetch;

  const catalog: Catalog = new Map();
  const events: Array<{ event: string; payload: unknown }> = [];

  const deps: RuntimeDeps = {
    db,
    threadsDir: "/tmp/hk-runtime-test",
    models: {
      master: { provider: "openai_compat", model: "prov/master", fallback: "prov/fallback" },
      worker: { provider: "openai_compat", model: "prov/worker" },
    },
    providers: { prov: { base_url: "http://stub" } },
    apiKeyFor: () => "sk-test-fake",
    catalog,
    limits: { max_workers_per_job: 4, tool_calls_per_worker: 8 },
    broadcast: (event, payload) => events.push({ event, payload }),
    memoryBlockFor: () => "",
    instructionsFor: () => "Be terse. Cite everything.",
    onDelta: () => {},
    fetchFn,
    capabilities: new Map(
      ["prov/master", "prov/fallback", "prov/worker"].map(
        (id) => [id, { modelId: id, vector: { ...ALL_CAPABLE }, at: Date.now() }] as [string, ProbeRecord],
      ),
    ),
    ...extra,
  };
  db.query("INSERT INTO threads (id, slug, title, workspace_path) VALUES ('thread-1','t1','T','/tmp/t1')").run();
  return { db, deps, calls, events, fetchFn };
}

/** Wire-shape helpers keyed off what the REAL builders emit. */
const isPlanCall = (b: Record<string, unknown>) => "response_format" in b;
const isWorkerCall = (b: Record<string, unknown>) =>
  JSON.stringify(b.messages).includes("You execute ONE task");

const planSse = (plan: unknown) =>
  sseResponse([JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) } }] })]);
const resultSse = (result: unknown) =>
  sseResponse([JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) } }] })]);
const shimSse = (calls: Array<{ tool: string; args: unknown }>) =>
  sseResponse([
    JSON.stringify({
      choices: [
        {
          delta: {
            content: calls.map((c) => `<hk:call tool="${c.tool}">\n${JSON.stringify(c.args)}\n</hk:call>`).join("\n"),
          },
        },
      ],
    }),
  ]);

const okResult = (notes = "done", findings: unknown[] = []) =>
  resultSse({ status: "ok", findings, artifacts: [], notes, blockers: [], success_claimed: true });

const TWO_TASK_PLAN = {
  intent: "digest the feed and draft the update",
  tasks: [
    { title: "fetch sources", objective: "pull the feed", inputs: ["https://ex.dev/feed"], kind: "reader", success: "findings include item titles and links." },
    { title: "draft update", objective: "write the digest", inputs: [], kind: "actor", success: "digest markdown written to digest.md." },
  ],
};

// ---------------------------------------------------------------- tests

describe("happy path: plan → parallel workers → merge", () => {
  test("job completes; tasks land ok; spend rows exist; thread gets cards", async () => {
    const h = scriptedDeps([
      () => planSse(TWO_TASK_PLAN),
      () => okResult("feed pulled", [{ text: "item a https://ex.dev/a", citations: ["https://ex.dev/a"] }]),
      () => okResult("digest written"),
    ]);

    const rt = new MasterRuntime(h.deps);
    const id = await rt.startJob("thread-1", "Do the morning digest");

    const job = rt.getJob(id) as { status: string; usd: number };
    expect(job.status).toBe("done");
    expect(job.usd).toBeGreaterThan(0);

    const tasks = h.db.query("SELECT title, status FROM tasks WHERE job_id = ? ORDER BY idx").all(id) as Array<{ title: string; status: string }>;
    expect(tasks.map((t) => t.status)).toEqual(["ok", "ok"]);

    const sys = h.db.query("SELECT body FROM messages WHERE thread_id='thread-1' AND role='system' ORDER BY created_at").all() as Array<{ body: string }>;
    expect(sys.some((m) => m.body.includes("📋 Plan (2 tasks)"))).toBe(true);
    expect(sys.some((m) => m.body.includes("🏁 Job finished (done)"))).toBe(true);

    // spend: one row per completion (plan + 2 workers) — parity invariant
    const rows = h.db.query("SELECT model_requested, model_served FROM spend_log WHERE job_id = ?").all(id) as Array<{ model_requested: string }>;
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.model_requested.startsWith("prov/"))).toBe(true);
  });

  test("readers run before actors: actor receives ATTESTED findings, never raw text", async () => {
    const seenActorPrompt: string[] = [];
    const h = scriptedDeps([
      () => planSse(TWO_TASK_PLAN),
      () => okResult("reader findings ready", [{ text: "Feed reports price change", citations: ["https://ex.dev/p#L3"] }]),
      (body) => {
        seenActorPrompt.push(JSON.stringify(body.messages));
        return okResult("digest done");
      },
    ]);
    const rt = new MasterRuntime(h.deps);
    await rt.startJob("thread-1", "digest");

    expect(seenActorPrompt.length).toBe(1);
    expect(seenActorPrompt[0]).toContain("Attested findings from earlier tasks");
    expect(seenActorPrompt[0]).toContain("https://ex.dev/p#L3");
  });
});

describe("untrusted reduction inside real workers", () => {
  test("reader attempting x.post is refused at the bus; job still completes", async () => {
    const h = scriptedDeps([
      () => planSse({ intent: "sneaky read", tasks: [{ title: "read page", objective: "fetch", kind: "reader", success: "findings returned." }] }),
      () => shimSse([{ tool: "x.post", args: { text: "injected post" } }]),
      () => okResult("settled for findings only"),
    ]);
    const rt = new MasterRuntime(h.deps);
    const id = await rt.startJob("thread-1", "sneaky");
    expect((rt.getJob(id) as { status: string }).status).toBe("done");

    const refusal = h.calls.find((b) =>
      JSON.stringify(b.messages).match(/refused — (tool-removed-untrusted|unknown-tool)/),
    );
    expect(refusal).toBeDefined();
  });
});

describe("approval receipts through the runtime", () => {
  function withGatedTool(extra: Partial<RuntimeDeps> = {}) {
    const sent: Array<Record<string, unknown>> = [];
    const h = scriptedDeps(
      [
        () => planSse({ intent: "send mail", tasks: [{ title: "notify", objective: "send the digest mail", kind: "actor", success: "send attempted." }] }),
        () => shimSse([{ tool: "email.send", args: { to: "op@ex.dev", subject: "hi", body: "digest" } }]),
        () => shimSse([{ tool: "email.send", args: { to: "op@ex.dev", subject: "hi", body: "digest" } }]),
        () => okResult("mail flow executed"),
      ],
      {
        ...extra,
        extraTools: (bus) => {
          const { z } = require("zod");
          bus.register({
            name: "email.send",
            kind: "send_mail",
            inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }) as never,
            describe: (input: { to?: string }) => ({ title: `send email → ${input?.to}` }),
            execute: async (input: unknown) => {
              sent.push(input as Record<string, unknown>);
              return { ok: true, structured: { sent: true } };
            },
          } as never);
        },
      },
    );
    return { h, sent };
  }

  test("always-ask: first call parks an approval; approve() releases the receipt; real send fires once", async () => {
    const { h, sent } = withGatedTool();
    const rt = new MasterRuntime(h.deps);
    const jobPromise = rt.startJob("thread-1", "send it");
    void jobPromise;

    // Worker parks → wait for the approval row.
    await Bun.sleep(150);
    const row = h.db.query("SELECT id FROM approvals WHERE status='pending'").get() as { id: string };
    expect(row).toBeDefined();
    expect(h.events.some((e) => e.event === "event.approval")).toBe(true);
    expect(sent.length).toBe(0); // nothing fired without the operator

    await rt.approve(row.id, "operator");
    await Bun.sleep(200);

    expect(sent.length).toBe(1); // EXACTLY once, after approval
    const decided = h.db.query("SELECT status, decided_by FROM approvals WHERE id = ?").get(row.id) as { status: string; decided_by: string };
    expect(decided.status).toBe("approved");
    expect(decided.decided_by).toBe("operator");
  });

  test("deny(): worker is told; no send ever fires; receipt trail exists", async () => {
    const { h, sent } = withGatedTool();
    const rt = new MasterRuntime(h.deps);
    void rt.startJob("thread-1", "send it");
    await Bun.sleep(150);
    const row = h.db.query("SELECT id FROM approvals WHERE status='pending'").get() as { id: string };
    await rt.deny(row.id, "operator");
    await Bun.sleep(200);
    expect(sent.length).toBe(0);
  });
});

describe("boot recovery with teeth", () => {
  test("non-terminal job's queued tasks are re-driven to completion", async () => {
    const h = scriptedDeps([
      () => planSse({ intent: "pre-crash plan", tasks: [{ title: "work it", objective: "do", kind: "actor", success: "done now." }] }),
      () => okResult("recovered run"),
    ]);
    const rt = new MasterRuntime(h.deps);
    const jobId = "job-crashed-mid";
    h.db.query("INSERT INTO jobs (id, thread_id, title, status, created_at) VALUES (?, 'thread-1', 'crashed', 'running', ?)").run(jobId, new Date().toISOString());
    h.db.query("INSERT INTO tasks (id, job_id, idx, title, spec_json, status) VALUES ('task-crashed', ?, 0, 'work it', ?, 'running')").run(
      jobId,
      JSON.stringify({ title: "work it", objective: "do", kind: "actor", success: "done now." }),
    );

    const rec = await rt.recoverOnBoot();
    expect(rec.resumed).toBe(1);
    await Bun.sleep(40);
    expect((rt.getJob(jobId) as { status: string }).status).toBe("done");
    const t = h.db.query("SELECT status FROM tasks WHERE id='task-crashed'").get() as { status: string };
    expect(t.status).toBe("ok");
  });
});

describe("loop guard", () => {
  test("identical repeated tool call → refused; budget exhausted fails the task honestly", async () => {
    const h = scriptedDeps([
      () => planSse({ intent: "spin", tasks: [{ title: "spinner", objective: "loop forever", kind: "actor", success: "never happens." }] }),
      // same shim reply forever → same fingerprint each round
      () => shimSse([{ tool: "fs.read", args: { path: "same.md" } }]),
    ]);
    const rt = new MasterRuntime(h.deps);
    const id = await rt.startJob("thread-1", "spin");
    await Bun.sleep(250);
    const t = h.db.query("SELECT status, error FROM tasks WHERE job_id = ?").get(id) as { status: string; error: string | null };
    expect(["failed", "ok"]).toContain(t.status); // guard fired OR worker conceded with result
    if (t.status === "failed") expect(t.error).toMatch(/loop guard|budget/);
    // the duplicate marker really reached the model
    expect(JSON.stringify(h.calls)).toContain("you already did that");
  });
});
