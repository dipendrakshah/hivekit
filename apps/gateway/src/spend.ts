/**
 * Spend log (§4.4.3) — SQLite-backed SpendLogger for @hivekit/models.
 * Migration v2: one row per completion, model REQUESTED vs model SERVED,
 * price snapshotted per row. `usageEstimated` rows are honest about being
 * estimates so cost analysis never blends guesses into measurements.
 */
import type { Database } from "bun:sqlite";
import type { SpendLogger, SpendRow } from "@hivekit/models";

export const MIGRATION_V2 = `
CREATE TABLE IF NOT EXISTS spend_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  job_id        TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  task_id       TEXT,
  provider      TEXT,
  model_requested TEXT NOT NULL,
  model_served    TEXT NOT NULL,
  tokens_in     INTEGER NOT NULL,
  tokens_out    INTEGER NOT NULL,
  usd           REAL NOT NULL,
  usage_estimated INTEGER NOT NULL DEFAULT 0,
  price_in_per_m  REAL,
  price_out_per_m REAL
);
CREATE INDEX IF NOT EXISTS idx_spend_job ON spend_log(job_id);
CREATE INDEX IF NOT EXISTS idx_spend_thread ON spend_log(thread_id);
`;

export function ensureSpendMigration(db: Database): void {
  const row = db
    .query("SELECT name FROM schema_migrations WHERE version = 2")
    .get() as { name: string } | undefined;
  if (row) return;
  const tx = db.transaction(() => {
    db.exec(MIGRATION_V2);
    db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'spend-log', ?)").run(
      new Date().toISOString(),
    );
  });
  tx();
}

export function makeSqliteSpendLogger(db: Database): SpendLogger {
  return {
    record(opts): SpendRow {
      const at = new Date().toISOString();
      db.query(
        `INSERT INTO spend_log
           (at, job_id, thread_id, task_id, provider, model_requested, model_served,
            tokens_in, tokens_out, usd, usage_estimated, price_in_per_m, price_out_per_m)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        at,
        opts.attribution.job_id,
        opts.attribution.thread_id,
        opts.attribution.task_id,
        opts.provider,
        opts.modelRequested,
        opts.served.servedModelId,
        opts.served.usage.tokensIn,
        opts.served.usage.tokensOut,
        opts.usd,
        opts.served.usageEstimated ? 1 : 0,
        opts.priceInPerM,
        opts.priceOutPerM,
      );
      return {
        at,
        job_id: opts.attribution.job_id,
        thread_id: opts.attribution.thread_id,
        task_id: opts.attribution.task_id,
        provider: opts.provider,
        model_requested: opts.modelRequested,
        model_served: opts.served.servedModelId,
        tokens_in: opts.served.usage.tokensIn,
        tokens_out: opts.served.usage.tokensOut,
        usd: opts.usd,
        usageEstimated: opts.served.usageEstimated,
        priceInPerM: opts.priceInPerM,
        priceOutPerM: opts.priceOutPerM,
      };
    },
  };
}

export function jobSpendUsd(db: Database, jobId: string): number {
  const row = db
    .query("SELECT COALESCE(SUM(usd), 0) AS total FROM spend_log WHERE job_id = ?")
    .get(jobId) as { total: number };
  return row?.total ?? 0;
}
