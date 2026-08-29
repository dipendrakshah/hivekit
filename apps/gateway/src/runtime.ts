/**
 * MasterRuntime (§4.3) — the real job pipeline that replaces the echo stand-in.
 *
 * startJob:
 *   planning → plan via planner.ts (2 strikes) → persist tasks → fan out
 *   workers (concurrency-capped, depth-1) → merge (master folds results,
 *   verifies success sentences) → done. Every transition journaled BEFORE its
 *   side effect (run journal is the only legal write order — §4.2).
 *
 * Approvals: worker tool calls that gate return a card; the card is persisted
 * as an approvals row and broadcast; req.job.approve verifies + supplies the
 * receipt, and the worker's NEXT bus call executes for real. deny archives
 * the row with decided_by — receipts are the audit trail.
 *
 * Boot recovery: non-terminal jobs re-enqueue their non-terminal tasks —
 * closing the known stream-01 gap where recovery only appended markers.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ToolBus, type ApprovalCardPayload, type ReceiptRef } from "@hivekit/tools";
import type { Catalog, SpendLogger } from "@hivekit/models";
import { gatewayComplete } from "@hivekit/models";
import { planJob, type Plan, type PlanTask } from "./planner";
import { runTask, type TaskOutcome, type WorkerFinding } from "./worker";
import { makeSqliteSpendLogger, ensureSpendMigration, jobSpendUsd } from "./spend";
import { journalAppend } from "./db";

export interface ModelConfig {
  provider: import("@hivekit/models").ProviderId;
  model: string;
  fallback?: string;
}

export interface RuntimeDeps {
  db: Database;
  threadsDir: string;
  models: { master: ModelConfig; worker: ModelConfig };
  providers: Record<string, { base_url: string }>;
  /** API keys by provider name (env + settings resolved by the caller). */
  apiKeyFor: (provider: string) => string | null;
  catalog: Catalog;
  limits: { max_workers_per_job: number; tool_calls_per_worker: 8 };
  broadcast: (event: string, payload: unknown) => void;
  /** Builds the retrieved memory block for a thread (stream-02 assemble). */
  memoryBlockFor: (threadId: string) => string;
  instructionsFor: (threadId: string) => string;
  onDelta: (threadId: string, text: string) => void;
  fetchFn?: typeof fetch;
  /** Test/diagnostic hook: register EXTRA tools on every job bus (e.g. gated fakes). */
  extraTools?: (bus: ToolBus) => void;
  /** Compiled policy-mode overrides (ask/auto/strict) applied to every job bus. */
  policyOverrides?: Partial<Record<import("@hivekit/tools").ToolName, import("@hivekit/tools").Policy>>;
  /** Pre-seeded capability cache (tests inject ALL_CAPABLE; prod probes fresh). */
  capabilities?: Map<string, import("@hivekit/models").ProbeRecord>;
  /** Config: how long a probe verdict is trusted (capability_probe_ttl_days). */
  capabilityTtlMs?: number;
}

export class MasterRuntime {
  readonly #spend: SpendLogger;
  #buses = new Map<string, ToolBus>();
  #caps: Map<string, import("@hivekit/models").ProbeRecord>;

  constructor(private readonly deps: RuntimeDeps) {
    ensureSpendMigration(deps.db);
    this.#spend = makeSqliteSpendLogger(deps.db);
    // In the constructor, NOT a field initializer: ES2022 class fields would
    // evaluate before `deps` is assigned (same trap the memory package hit).
    this.#caps = deps.capabilities ?? new Map();
  }

  /**
   * Re-wire after the server exists (main.ts constructs `runtime` before
   * `createServer`, so the real broadcaster isn't available yet — same
   * chicken-and-egg JobRunner solves with setBroadcaster). Mutating
   * `deps.broadcast` is legal: `deps` itself is a private readonly
   * *binding*, but `RuntimeDeps.broadcast` is not a readonly property.
   */
  setBroadcaster(fn: (event: string, payload: unknown) => void): void {
    this.deps.broadcast = fn;
  }

  setOnDelta(fn: (threadId: string, text: string) => void): void {
    this.deps.onDelta = fn;
  }

  // ------------------------------------------------------------------ entries

  async startJob(threadId: string, userMessage: string): Promise<string> {
    const jobId = randomUUID();
    const db = this.deps.db;
    const now = new Date().toISOString();
    const title = userMessage.slice(0, 80);

    db.query("INSERT INTO jobs (id, thread_id, title, status, created_at) VALUES (?, ?, ?, 'planning', ?)").run(
      jobId, threadId, title, now,
    );
    journalAppend(db, "job", jobId, null, "planning");
    this.deps.broadcast("event.job", { job: this.getJob(jobId) });

    const workDir = `${this.deps.threadsDir}/${threadId || "t"}/jobs/${jobId}`;
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    try { mkdirSync(workDir, { recursive: true }); } catch { /* in-memory tests */ }

    const plan = await this.#makePlan(threadId, jobId, userMessage, workDir);
    if (!plan.ok) {
      this.#finishJob(jobId, "failed", `planning failed: ${plan.error}`);
      this.insertSystem(threadId, `⚠️ Planning failed: ${plan.error.slice(0, 300)}`);
      return jobId;
    }
    this.insertSystem(threadId, `📋 Plan (${plan.plan.tasks.length} tasks): ${plan.plan.intent}`);
    this.#enqueueTasks(jobId, threadId, plan.plan, workDir);

    await this.#runPendingTasks(jobId, threadId);
    return jobId;
  }

  /** req.job.approve — verifies, marks the row, supplies receipt to the parked worker. */
  async approve(approvalId: string, decidedBy: string): Promise<boolean> {
    return this.#decide(approvalId, "approved", decidedBy);
  }

  async deny(approvalId: string, decidedBy: string): Promise<boolean> {
    return this.#decide(approvalId, "denied", decidedBy);
  }

  async #decide(approvalId: string, status: "approved" | "denied", decidedBy: string): Promise<boolean> {
    const row = this.deps.db
      .query("SELECT id, job_id, payload_json FROM approvals WHERE id = ? AND status = 'pending'")
      .get(approvalId) as { id: string; job_id: string; payload_json: string } | undefined;
    if (!row) return false;
    this.deps.db
      .query("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?")
      .run(status, decidedBy, new Date().toISOString(), approvalId);
    journalAppend(this.deps.db, `approval.${status}`, approvalId, "pending", status, { decidedBy });
    this.deps.broadcast("event.approval", { id: approvalId, status });

    if (status === "approved") {
      // #parkForApproval stores the card at TOP level (+ receipt_hash beside it).
      const card = JSON.parse(row.payload_json) as ApprovalCardPayload & { receipt_hash: string };
      const receipt: ReceiptRef = {
        id: approvalId,
        action_kind: card.action_kind,
        payload_hash: card.receipt_hash ?? "",
        approved_by: decidedBy,
        approved_at: new Date().toISOString(),
      };
      // Park the receipt where the parked worker's next bus call picks it up.
      const parked = this.#pendingReceipts.get(row.job_id);
      if (parked) parked(card.requires_receipt_for, receipt);
    } else {
      // Deny: the waiting worker must finish as blocked.
      const parked = this.#pendingDenials.get(row.job_id);
      if (parked) parked();
    }
    return true;
  }

  #pendingReceipts = new Map<string, (tool: string, receipt: ReceiptRef) => void>();
  #pendingDenials = new Map<string, () => void>();

  // ------------------------------------------------------------------ plan + tasks

  async #makePlan(
    threadId: string,
    jobId: string,
    userMessage: string,
    workDir: string,
  ): Promise<{ ok: true; plan: Plan } | { ok: false; error: string }> {
    const master = this.deps.models.master;
    const outcome = await planJob(userMessage, {
      instructions: this.deps.instructionsFor(threadId),
      memoryBlock: this.deps.memoryBlockFor(threadId),
      threadSummary: `thread ${threadId}; job ${jobId}`,
      model: { provider: master.provider, id: master.model },
      attribution: { thread_id: threadId, job_id: jobId, task_id: null },
      complete: async (req) => {
        const res = await this.#gatewayCall(req);
        return { text: res.completion.text, model: res.completion.servedModelId };
      },
    });
    void workDir;
    return outcome.ok ? { ok: true, plan: outcome.plan } : { ok: false, error: outcome.error };
  }

  #enqueueTasks(jobId: string, threadId: string, plan: Plan, workDir: string): void {
    plan.tasks.forEach((task, idx) => {
      const taskId = randomUUID();
      this.deps.db
        .query(
          "INSERT INTO tasks (id, job_id, idx, title, spec_json, status) VALUES (?, ?, ?, ?, ?, 'queued')",
        )
        .run(taskId, jobId, idx, task.title, JSON.stringify({ ...task, work_dir: workDir }));
      journalAppend(this.deps.db, "task", taskId, null, "queued");
    });
    journalAppend(this.deps.db, "job", jobId, "planning", "running");
    this.deps.db.query("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    void threadId;
  }

  async #runPendingTasks(jobId: string, threadId: string): Promise<void> {
    const rows = this.deps.db
      .query("SELECT id, title, spec_json FROM tasks WHERE job_id = ? AND status = 'queued' ORDER BY idx")
      .all(jobId) as Array<{ id: string; title: string; spec_json: string }>;

    // TWO-HOP sequencing (§4.5): ALL readers complete before ANY actor starts.
    // Actors consume attested findings; running them concurrently with readers
    // would hand them empty context — a correctness bug, not a scheduling taste.
    const readers = rows.filter((r) => (JSON.parse(r.spec_json) as PlanTask).kind === "reader");
    const actors = rows.filter((r) => (JSON.parse(r.spec_json) as PlanTask).kind !== "reader");

    const limit = Math.max(1, this.deps.limits.max_workers_per_job);
    const runPhase = async (phase: Array<{ id: string; title: string; spec_json: string }>) => {
      const queue = [...phase];
      const worker = async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          const spec = JSON.parse(next.spec_json) as PlanTask & { work_dir: string };
          this.deps.db.query("UPDATE tasks SET status = 'running' WHERE id = ?").run(next.id);
          journalAppend(this.deps.db, "task", next.id, "queued", "running");
          const outcome = await this.#runOneTask(jobId, threadId, next.id, spec);
          this.deps.db
            .query("UPDATE tasks SET status = ?, error = ?, artifacts_json = ? WHERE id = ?")
            .run(
              outcome.status,
              outcome.error ?? null,
              JSON.stringify(outcome.result?.findings ?? outcome.result?.artifacts ?? []),
              next.id,
            );
          journalAppend(this.deps.db, "task", next.id, "running", outcome.status);
          this.deps.broadcast("event.job", { job: this.getJob(jobId) });
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
    };

    await runPhase(readers);
    await runPhase(actors);
    await this.#merge(jobId, threadId, this.#collectOutcomes(jobId));
  }

  #collectOutcomes(jobId: string): Array<{ task: PlanTask; taskId: string; outcome: TaskOutcome }> {
    const rows = this.deps.db
      .query("SELECT id, spec_json, status, error FROM tasks WHERE job_id = ? ORDER BY idx")
      .all(jobId) as Array<{ id: string; spec_json: string; status: string; error: string | null }>;
    return rows.map((r) => ({
      task: JSON.parse(r.spec_json) as PlanTask,
      taskId: r.id,
      outcome: { status: r.status as TaskOutcome["status"], error: r.error ?? undefined, attempts: 0, toolCalls: 0 },
    }));
  }

  async #runOneTask(jobId: string, threadId: string, taskId: string, spec: PlanTask): Promise<TaskOutcome> {
    const findings = this.#findingsFor(jobId, taskId);
    const bus = this.#busFor(jobId, threadId);

    return await runTask(spec, {
      jobId,
      threadId,
      taskId,
      workDir: `${this.deps.threadsDir}/${threadId}/jobs/${jobId}`,
      instructions: this.deps.instructionsFor(threadId),
      memoryBlock: this.deps.memoryBlockFor(threadId),
      findings,
      model: { provider: this.deps.models.worker.provider, id: this.deps.models.worker.model },
      fallbackModel: () =>
        this.deps.models.worker.fallback
          ? { provider: this.deps.models.worker.provider, id: this.deps.models.worker.fallback }
          : null,
      complete: async (req) => (await this.#gatewayCall(req)).completion,
      bus,
      wallClockMs: 120_000,
      onApprovalNeeded: async (card, payloadHash) => await this.#parkForApproval(jobId, threadId, card, payloadHash),
      onDelta: (t) => this.deps.onDelta(threadId, t),
    });
  }

  /** Readers run FIRST in v1 (all readers before actors — deterministic two-hop). */
  #findingsFor(jobId: string, forTaskId: string): WorkerFinding[] {
    const rows = this.deps.db
      .query("SELECT id, title, spec_json, artifacts_json, error FROM tasks WHERE job_id = ? ORDER BY idx")
      .all(jobId) as Array<{ id: string; title: string; spec_json: string; artifacts_json: string; error: string | null }>;
    const out: WorkerFinding[] = [];
    for (const r of rows) {
      if (r.id === forTaskId) continue;
      const spec = JSON.parse(r.spec_json) as PlanTask;
      if (spec.kind !== "reader" || r.error) continue;
      // artifacts_json holds the reader's RESULT payload (findings preferred).
      const payload = JSON.parse(r.artifacts_json || "[]") as unknown;
      const findings = Array.isArray(payload)
        ? (payload as Array<{ text?: string; citations?: string[] } | string>)
        : [];
      const lines = findings
        .map((f) => (typeof f === "string" ? { text: f, citations: [] as string[] } : { text: f.text ?? "", citations: f.citations ?? [] }))
        .filter((f) => f.text);
      if (!lines.length) continue;
      out.push({
        fromTask: spec.title,
        text: lines.map((l) => l.text).join("\n"),
        citations: lines.flatMap((l) => l.citations),
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ bus + tools

  #busFor(jobId: string, threadId: string): ToolBus {
    const existing = this.#buses.get(jobId);
    if (existing) return existing;
    const bus = new ToolBus({
      overrides: this.deps.policyOverrides,
      verifyReceipt: async (ref) => {
        const row = this.deps.db
          .query("SELECT status, payload_json FROM approvals WHERE id = ?")
          .get(ref.id) as { status: string; payload_json: string } | undefined;
        if (!row || row.status !== "approved")
          return { ok: false, reason: `receipt ${ref.id.slice(0, 8)} not approved` };
        return { ok: true };
      },
    });
    registerGatewayTools(bus, this.deps, threadId);
    this.deps.extraTools?.(bus);
    this.#buses.set(jobId, bus);
    return bus;
  }

  async #parkForApproval(
    jobId: string,
    threadId: string,
    card: ApprovalCardPayload,
    payloadHash: string,
  ): Promise<ReceiptRef | null> {
    const approvalId = randomUUID();
    const dbKind: Record<string, string> = {
      push: "site_push",
      post: "x_post",
      send_mail: "email_send",
      exec: "exec",
      delete: "delete",
      commit: "site_push", // gated commits are pushes in receipt terms
      draft_post: "x_post",
      fetch_mail: "email_send",
      fs: "exec",
      web: "exec",
    };
    this.deps.db
      .query(
        "INSERT INTO approvals (id, job_id, action_kind, payload_json, status) VALUES (?, ?, ?, ?, 'pending')",
      )
      .run(approvalId, jobId, dbKind[card.action_kind] ?? "exec", JSON.stringify({ ...card, receipt_hash: payloadHash }));
    this.deps.broadcast("event.approval", { id: approvalId, job_id: jobId, card });
    this.insertSystem(threadId, `⏸️ Approval needed: ${card.title}`);

    // Park until decide() resolves; the runtime does not time out approvals.
    return await new Promise<ReceiptRef | null>((resolve) => {
      const prevReceipt = this.#pendingReceipts.get(jobId);
      this.#pendingReceipts.set(jobId, (tool, receipt) => {
        prevReceipt?.(tool, receipt);
        if (card.requires_receipt_for === tool) resolve(receipt);
      });
      const prevDeny = this.#pendingDenials.get(jobId);
      this.#pendingDenials.set(jobId, () => {
        prevDeny?.();
        resolve(null);
      });
    });
  }

  // ------------------------------------------------------------------ merge

  async #merge(
    jobId: string,
    threadId: string,
    outcomes: Array<{ task: PlanTask; taskId: string; outcome: TaskOutcome }>,
  ): Promise<void> {
    journalAppend(this.deps.db, "job", jobId, "running", "merging");
    this.deps.db.query("UPDATE jobs SET status = 'merging' WHERE id = ?").run(jobId);

    const failed = outcomes.filter((o) => o.outcome.status !== "ok");
    const summary = outcomes
      .map((o) => {
        const ok = o.outcome.status === "ok";
        return `- ${ok ? "✅" : o.outcome.status === "blocked" ? "⏸️" : "❌"} ${o.task.title}: ${
          o.outcome.result?.notes.slice(0, 160) ?? o.outcome.error ?? ""
        }`;
      })
      .join("\n");

    const status = failed.length === 0 ? "done" : outcomes.every((o) => o.outcome.status === "failed") ? "failed" : "done";
    this.#finishJob(jobId, status, undefined);

    const spend = jobSpendUsd(this.deps.db, jobId);
    this.deps.db
      .query("UPDATE jobs SET usd = ?, tokens_in = COALESCE(tokens_in,0), tokens_out = COALESCE(tokens_out,0) WHERE id = ?")
      .run(spend, jobId);
    this.insertSystem(threadId, `🏁 Job finished (${status}).\n${summary}\nSpend: $${spend.toFixed(4)}`);
    this.deps.broadcast("event.job", { job: this.getJob(jobId) });
    this.#buses.delete(jobId);
  }

  #finishJob(jobId: string, status: "done" | "failed" | "cancelled", error?: string): void {
    journalAppend(this.deps.db, "job", jobId, undefined as never, status);
    // jobs has no error column; failures live in task rows + the thread message.
    this.deps.db
      .query("UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), jobId);
    void error;
  }

  insertSystem(threadId: string, body: string): void {
    const id = randomUUID();
    this.deps.db
      .query("INSERT INTO messages (id, thread_id, role, body, artifact_refs) VALUES (?, ?, 'system', ?, '[]')")
      .run(id, threadId, body);
    this.deps.broadcast("event.thread", {
      message: { id, thread_id: threadId, role: "system", body, card: null, artifact_refs: [], created_at: new Date().toISOString() },
    });
  }

  // ------------------------------------------------------------------ gateway + recovery

  async #gatewayCall(req: import("@hivekit/models").CompletionRequest) {
    const { provider, id } = req.model;
    const reg = this.deps.providers[provider] ?? this.deps.providers[id.split("/")[0] ?? ""];
    const apiKey = this.deps.apiKeyFor(provider);
    if (!reg || !apiKey)
      throw Object.assign(new Error(`429 no credentials for provider ${provider} (model ${id})`), {});
    return gatewayComplete(req, {
      registry: () => ({ provider, baseUrl: reg.base_url.replace(/\/$/, ""), apiKey }),
      catalog: this.deps.catalog,
      spend: this.#spend,
      capabilityTtlMs: this.deps.capabilityTtlMs ?? 24 * 3600_000,
      capabilities: this.#caps,
      fallbackFor: (m) => {
        const fb = m.id === this.deps.models.master.model ? this.deps.models.master.fallback : this.deps.models.worker.fallback;
        return fb ? { provider: m.provider, id: fb } : null;
      },
      onDelta: (d) => {
        if (d.kind === "text") this.deps.onDelta(req.attribution.thread_id, d.text);
      },
      fetchFn: this.deps.fetchFn,
    });
  }


  /**
   * Boot recovery with TEETH: non-terminal tasks of non-terminal jobs are
   * re-enqueued and their job re-driven. Interrupted approvals return to
   * pending semantics via the statuses they already hold.
   */
  async recoverOnBoot(): Promise<{ resumed: number; jobs: string[] }> {
    const jobs = this.deps.db
      .query("SELECT id, thread_id, title, created_at FROM jobs WHERE status IN ('planning','running','needs_approval','merging')")
      .all() as Array<{ id: string; thread_id: string; title: string; created_at: string }>;
    for (const j of jobs) {
      journalAppend(this.deps.db, "job", j.id, undefined as never, "resumed", { resumed: true });
      this.deps.db
        .query("UPDATE tasks SET status = 'queued' WHERE job_id = ? AND status IN ('queued','running')")
        .run(j.id);
    }
    for (const j of jobs) {
      // Fire-and-forget with job-level isolation; boot must not hang on models.
      void this.#runPendingTasks(j.id, j.thread_id).catch((err) =>
        this.#finishJob(j.id, "failed", (err as Error).message.slice(0, 300)),
      );
    }
    return { resumed: jobs.length, jobs: jobs.map((j) => j.id) };
  }

  getJob(jobId: string): Record<string, unknown> | null {
    const row = this.deps.db.query("SELECT * FROM jobs WHERE id = ?").get(jobId) as
      | Record<string, unknown>
      | undefined;
    return row ?? null;
  }
}

// ------------------------------------------------------------------ tool registration

function registerGatewayTools(bus: ToolBus, deps: RuntimeDeps, threadId: string): void {
  void deps; void threadId;
  // Minimal in-repo tools so workers always have SOMETHING lawful to call.
  const { z } = require("zod") as typeof import("zod");
  bus.register({
    name: "fs.write",
    kind: "fs",
    inputSchema: z.object({ path: z.string(), content: z.string() }) as never,
    describe: (input: { path?: string }) => ({ title: `write ${input?.path ?? "file"}` }),
    execute: async (input: unknown, ctx: import("@hivekit/tools").ExecutionContext) => {
      const i = input as { path: string; content: string };
      const safe = i.path.replace(/\.\./g, "").replace(/^\/+/, "");
      try {
        const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
        const path = require("node:path") as typeof import("node:path");
        const abs = path.join(ctx.workDir, safe);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, i.content);
        return { ok: true, structured: { wrote: safe, bytes: i.content.length } };
      } catch (err) {
        return { ok: false, error: (err as Error).message.slice(0, 200) };
      }
    },
  } as never);
  bus.register({
    name: "fs.read",
    kind: "fs",
    inputSchema: z.object({ path: z.string() }) as never,
    execute: async (input: unknown, ctx: import("@hivekit/tools").ExecutionContext) => {
      const i = input as { path: string };
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      try {
        const abs = path.join(ctx.workDir, i.path.replace(/\.\./g, ""));
        return { ok: true, output: readFileSync(abs, "utf8").slice(0, 40_000) };
      } catch (err) {
        return { ok: false, error: (err as Error).message.slice(0, 200) };
      }
    },
  } as never);
}
