/**
 * Routine engine — ARCHITECTURE §4.6, todo/04.
 *
 * Time is a parameter everywhere; nothing calls new Date() for truth. That
 * single constraint makes the hard claims provable: a VM that boots two days
 * later catches up EXACTLY ONCE flagged late, preflight failures never consume
 * their slot, and unchanged sources cost zero model calls (IncrementalGate).
 *
 * Persistence hides behind StateStore: SQLite in the gateway, Maps in tests.
 */
import { Cron } from "croner";
import { createHash } from "node:crypto";

export type NotifyPolicy = "always" | "on-approval-only" | "silent-until-done";

export interface RoutineDef {
  id: string;
  name: string;
  /** Croner 5-field pattern with optional trailing timezone, e.g. `0 7 * * * Asia/Kolkata`. */
  cron: string;
  prompt_template: string;
  enabled: boolean;
}

export interface RuntimeState {
  last_run_at: string | null;
  next_run_at: string | null;
}

/** Per-thread incremental markers: source url → content hash of last observation. */
export type SeenHashes = Record<string, string>;

export interface RoutineRecord {
  def: RoutineDef;
  state: RuntimeState;
  seen_hashes: SeenHashes;
}

export interface StateStore {
  get(routineId: string): Promise<RoutineRecord | null>;
  put(record: RoutineRecord): Promise<void>;
}

export function memoryStore(): StateStore {
  const m = new Map<string, RoutineRecord>();
  return {
    async get(id) {
      return m.get(id) ?? null;
    },
    async put(r) {
      m.set(r.def.id, r);
    },
  };
}

// ------------------------------------------------------------------ cron math

export function parseCron(spec: string): { pattern: string; timezone?: string } {
  const parts = spec.trim().split(/\s+/);
  if (parts.length < 5)
    throw new Error(`routine cron ${JSON.stringify(spec)} needs 5 fields`);
  const tzCandidate = parts[5];
  const timezone = tzCandidate && /^[A-Za-z_]+\/[A-Za-z_+/]+$/.test(tzCandidate) ? tzCandidate : undefined;
  return { pattern: parts.slice(0, 5).join(" "), timezone };
}

export function nextRunAfter(spec: string, after: Date): Date | null {
  try {
    const { pattern, timezone } = parseCron(spec);
    return new Cron(pattern, { timezone }).nextRun(after) ?? null;
  } catch (err) {
    throw new Error(`invalid cron ${JSON.stringify(spec)}: ${(err as Error).message}`);
  }
}

/** Ticks of `spec` in (fromInclusive, toExclusive) — STRICTLY after, since `from`
 * * carries last_run_at whose own tick already ran — capped vs runaway schedules. */
export function dueTicksBetween(spec: string, fromInclusive: Date, toExclusive: Date, cap = 40): Date[] {
  const out: Date[] = [];
  let cursor = fromInclusive;
  for (;;) {
    const next = nextRunAfter(spec, cursor);
    if (!next || !(next.getTime() < toExclusive.getTime())) break;
    out.push(next);
    if (out.length >= cap) break;
    cursor = next;
  }
  return out;
}

// ------------------------------------------------------------------ the engine

export interface PreflightCheck {
  name: string;
  run: () => Promise<{ ok: boolean; reason?: string }>;
}

export type RunKind = "scheduled" | "catchup-late";

export interface RunDecision {
  run: boolean;
  kind: RunKind | "none";
  skipReason?: string;
  missedTicks: number;
  next: Date | null;
}

const BOOT_LOOKBACK_MS = 24 * 3_600_000;

export class RoutineEngine {
  constructor(
    private readonly store: StateStore,
    private readonly preflight: PreflightCheck[] = [],
  ) {}

  /**
   * Boot path. Every tick missed while down collapses into ONE catch-up run,
   * flagged late. A preflight failure leaves state untouched (last_run_at
   * stays as-was), so the slot is NOT consumed and the next boot retries.
   */
  async reconcileOnBoot(def: RoutineDef, now: Date): Promise<RunDecision> {
    const rec = await this.#load(def);
    return this.#evaluate(def, rec, now, "catchup-late");
  }

  /** Timer path when croner fires a live tick. */
  async onTick(def: RoutineDef, now: Date): Promise<RunDecision> {
    const rec = await this.#load(def);
    return this.#evaluate(def, rec, now, "scheduled");
  }

  async #evaluate(def: RoutineDef, rec: RoutineRecord, now: Date, kindIfGo: RunKind): Promise<RunDecision> {
    // Compute the forward schedule BEFORE deciding anything — downtime and
    // skips must not desync next_run_at.
    const next = nextRunAfter(def.cron, now);

    const base: RunDecision = { run: false, kind: "none", missedTicks: 0, next };

    if (!def.enabled) {
      await this.persist({ ...rec, def, state: { ...rec.state, next_run_at: null } });
      return { ...base, skipReason: "disabled" };
    }

    let missedTicks = 0;
    if (kindIfGo === "catchup-late") {
      const anchor = rec.state.last_run_at ? new Date(rec.state.last_run_at) : new Date(now.getTime() - BOOT_LOOKBACK_MS);
      missedTicks = dueTicksBetween(def.cron, anchor, now).length;
      // Anchor predates us having any real runs? A brand-new routine catches up nothing.
      if (!rec.state.last_run_at) missedTicks = 0;
    }

    for (const check of this.preflight) {
      const r = await check.run();
      if (!r.ok) {
        // NO state mutation beyond auditing next tick: slot not consumed.
        await this.persist({ ...rec, def, state: { ...rec.state, next_run_at: next?.toISOString() ?? null } });
        return { ...base, skipReason: `preflight:${check.name}:${r.reason ?? "failed"}`, missedTicks, next };
      }
    }

    await this.persist({ ...rec, def, state: { ...rec.state, next_run_at: next?.toISOString() ?? null } });

    if (kindIfGo === "catchup-late" && missedTicks === 0)
      return { ...base, skipReason: "nothing-missed", missedTicks, next };

    return { run: true, kind: kindIfGo, missedTicks, next };
  }

  /** Gateway calls AFTER the routine job finishes successfully — the only writer of last_run_at. */
  async markRunComplete(routineId: string, at: Date, nextAfter?: Date): Promise<void> {
    const rec = await this.loadById(routineId);
    await this.persist({
      ...rec,
      state: {
        ...rec.state,
        last_run_at: at.toISOString(),
        next_run_at: nextAfter?.toISOString() ?? rec.state.next_run_at,
      },
    });
  }

  async loadById(routineId: string): Promise<RoutineRecord> {
    return (await this.store.get(routineId)) ?? emptyRec(routineId);
  }

  async #load(def: RoutineDef): Promise<RoutineRecord> {
    return (await this.store.get(def.id)) ?? emptyRec(def.id);
  }

  async persist(rec: RoutineRecord): Promise<void> {
    if (!rec.def.id) throw new Error("persist: record missing def.id");
    await this.store.put(rec);
  }
}

function emptyRec(id: string): RoutineRecord {
  return {
    def: { id, name: "", cron: "* * * * *", prompt_template: "", enabled: false },
    state: { last_run_at: null, next_run_at: null },
    seen_hashes: {},
  };
}

// ---------------------------------------------- incremental runs (todo/04 DoD)

export function hashSource(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * The zero-model-call lever: a sweep hashes each source it WOULD read; only
 * sources whose hash differs from the last completed run enter the plan.
 * The gateway asserts plan width == changed count with a call counter.
 */
export class IncrementalGate {
  constructor(private readonly store: StateStore) {}

  async whichChanged(routineId: string, sources: Record<string, string>): Promise<string[]> {
    const rec = (await this.store.get(routineId)) ?? emptyRec(routineId);
    return Object.entries(sources)
      .filter(([url, content]) => rec.seen_hashes[url] !== hashSource(content))
      .map(([url]) => url);
  }

  async commitSeen(routineId: string, sources: Record<string, string>): Promise<void> {
    const rec = (await this.store.get(routineId)) ?? emptyRec(routineId);
    const seen_hashes: SeenHashes = { ...rec.seen_hashes };
    for (const [url, content] of Object.entries(sources)) seen_hashes[url] = hashSource(content);
    await this.store.put({ ...rec, seen_hashes });
  }

  /** The operator lever: clearing `seen` forces a full re-run next time. */
  async clearSeen(routineId: string): Promise<void> {
    const rec = (await this.store.get(routineId)) ?? emptyRec(routineId);
    await this.store.put({ ...rec, seen_hashes: {} });
  }
}

// ------------------------------------------------- notify policies (§4.6)

export function shouldNotify(
  policy: NotifyPolicy,
  event: "run-done" | "approval-waiting" | "preflight-failed",
): boolean {
  switch (policy) {
    case "always":
      return true;
    case "on-approval-only":
      return event === "approval-waiting";
    case "silent-until-done":
      return event === "run-done";
  }
}
