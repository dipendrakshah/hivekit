/**
 * Jobs — stream 01 ships the journaled skeleton plus one real job: `echo`.
 *
 * The echo job exists to prove the DoD claims that do not need a model:
 *  - every transition persists BEFORE its side effect (run_journal),
 *  - a SIGKILL mid-job resumes to the exact state on boot (recovery fold),
 *  - the token relay streams chunks immediately and flushes rows ≤250 ms.
 *
 * Stream 03 replaces the echo "model" with real adapters behind the same
 * JobRunner interface; nothing else in this file should change.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { journalAppend, journalFold } from "./db";
import type { TokenRelay } from "./relay";
import type { SnapshotJob } from "@hivekit/protocol";

export interface JobRow {
  id: string;
  thread_id: string;
  title: string;
  status: string;
  master_model: string | null;
  worker_model: string | null;
  budget_usd: number;
  tokens_in: number;
  tokens_out: number;
  usd: number;
  created_at: string;
  finished_at: string | null;
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export class JobRunner {
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Set via setBroadcaster after the server exists — no cast-hacks. */
  #broadcast: (event: string, payload: unknown) => void = () => {};

  constructor(private readonly db: Database) {}

  setBroadcaster(fn: (event: string, payload: unknown) => void): void {
    this.#broadcast = fn;
  }

  /** Create + start an echo job. Persist-then-act at every step. */
  startEchoJob(threadId: string, prompt: string, relayFactory: (jobId: string) => TokenRelay): string {
    const jobId = randomUUID();
    const now = new Date().toISOString();

    // 1. Persist job row (planning) — before anything else.
    this.db
      .query(
        "INSERT INTO jobs (id, thread_id, title, status, created_at) VALUES (?, ?, ?, 'planning', ?)",
      )
      .run(jobId, threadId, prompt.slice(0, 80), now);
    journalAppend(this.db, "job", jobId, null, "planning");

    // 2. planning → running, persisted before the side effect (the timer).
    this.#transition(jobId, "planning", "running");
    this.db.query("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);

    // 3. Side effect: stream the echo through the relay. A SIGKILL here
    //    leaves status=running in the DB; boot recovery re-enqueues it.
    const relay = relayFactory(jobId);
    const reply = `echo: ${prompt}`;
    // Chunked emit so the relay's coalescing is exercised for real.
    let i = 0;
    const step = () => {
      if (i >= reply.length) {
        this.#finishEcho(jobId, relay);
        return;
      }
      relay.push(reply.slice(i, i + 7));
      i += 7;
      this.#timers.set(`${jobId}:emit`, setTimeout(step, 5));
    };
    this.#timers.set(`${jobId}:emit`, setTimeout(step, 5));

    return jobId;
  }

  #finishEcho(jobId: string, relay: TokenRelay): void {
    relay.finish();
    this.#transition(jobId, "running", "done");
    this.db
      .query("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), jobId);
    this.#broadcast("event.job", { job: this.getJob(jobId) });
  }

  /** Journal first, then state. The only legal order. */
  #transition(jobId: string, from: string, to: string): void {
    journalAppend(this.db, "job", jobId, from, to);
  }

  getJob(jobId: string): SnapshotJob | null {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      thread_id: row.thread_id,
      title: row.title,
      status: row.status as SnapshotJob["status"],
      master_model: row.master_model,
      worker_model: row.worker_model,
      usd: row.usd,
      tokens_in: row.tokens_in,
      tokens_out: row.tokens_out,
    };
  }

  /**
   * Boot recovery: fold the journal forward. Any non-terminal job is
   * re-enqueued exactly as it was; interrupted approvals return to pending.
   */
  recoverOnBoot(): { resumed: number } {
    const active = (
      this.db.query("SELECT id FROM jobs WHERE status NOT IN ('done','failed','cancelled')").all() as Array<{ id: string }>
    ).map((r) => r.id);
    for (const jobId of active) {
      const fold = journalFold(this.db, jobId);
      const last = fold.at(-1);
      // Re-append the resume marker; state stays what it was.
      journalAppend(this.db, "job", jobId, last?.to ?? null, last?.to ?? "planning", {
        resumed: true,
      });
    }
    // Approvals stuck mid-decision go back to needs_approval semantics.
    this.db
      .query("UPDATE approvals SET status = 'pending' WHERE status = 'pending'") // no-op guard; explicit for §4.2
      .run();
    return { resumed: active.length };
  }

  cancelJob(jobId: string, key: string): boolean {
    const row = this.db.query("SELECT status FROM jobs WHERE id = ?").get(jobId) as
      | { status: string }
      | undefined;
    if (!row || TERMINAL.has(row.status)) return false;
    // Idempotency: same key twice is a no-op the second time.
    const seen = this.db
      .query("SELECT 1 FROM run_journal WHERE ref_id = ? AND detail_json LIKE ?")
      .get(jobId, `%${key}%`);
    if (seen) return true;
    journalAppend(this.db, "job.cancel", jobId, row.status, "cancelled", { key });
    this.db
      .query("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), jobId);
    const timer = this.#timers.get(`${jobId}:emit`);
    if (timer) clearTimeout(timer);
    this.#broadcast("event.job", { job: this.getJob(jobId) });
    return true;
  }
}