/**
 * Spend recorder (§4.4.3) — a row per call with the model REQUESTED and the
 * model ACTUALLY SERVED (gateways substitute; an unattributed swap makes cost
 * analysis quietly wrong), price snapshotted per row, `usageEstimated` flagged
 * when the provider returned no numbers. Persisted as JSONL so the spend log
 * is complete, not approximate.
 */
import type { ProviderId, CallAttribution, Completion } from "./types";

export interface SpendRow {
  at: string;
  job_id: string;
  thread_id: string;
  task_id: string | null;
  provider: ProviderId | null;
  model_requested: string;
  model_served: string;
  tokens_in: number;
  tokens_out: number;
  usd: number;
  usageEstimated: boolean;
  priceInPerM: number | null;
  priceOutPerM: number | null;
}

export class SpendRecorder {
  readonly rows: SpendRow[] = [];

  constructor(
    private readonly persist?: (rows: SpendRow[]) => void,
  ) {}

  record(opts: {
    attribution: CallAttribution;
    provider: ProviderId | null;
    modelRequested: string;
    served: Pick<Completion, "servedModelId" | "usage" | "usageEstimated">;
    priceInPerM: number | null;
    priceOutPerM: number | null;
    usd: number;
  }): SpendRow {
    const row: SpendRow = {
      at: new Date().toISOString(),
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
    this.rows.push(row);
    this.persist?.(this.rows);
    return row;
  }

  totalUsd(): number {
    return this.rows.reduce((a, r) => a + r.usd, 0);
  }

  byJob(jobId: string): SpendRow[] {
    return this.rows.filter((r) => r.job_id === jobId);
  }
}

/** Gateway-facing name — the spend log is an interface, not a concrete class. */
export interface SpendLogger {
  record(opts: Parameters<SpendRecorder["record"]>[0]): SpendRow;
}