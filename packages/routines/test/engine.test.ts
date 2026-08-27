/**
 * Routine engine tests (§4.6): every claim runs against injected time, so
 * "VM rebooted mid-routine" and "unchanged sources" are facts, not hopes.
 */
import { describe, expect, test } from "bun:test";

import {
  RoutineEngine,
  IncrementalGate,
  memoryStore,
  nextRunAfter,
  dueTicksBetween,
  hashSource,
  shouldNotify,
} from "../src/index";
import type { RoutineDef } from "../src/index";

const D = (s: string) => new Date(s);

const def = (id: string, cron = "0 7 * * *"): RoutineDef => ({
  id,
  name: id,
  cron: `${cron} Asia/Kolkata`,
  prompt_template: "run the sweep",
  enabled: true,
});

describe("cron math", () => {
  test("next run respects timezone suffix", () => {
    const after = D("2026-08-26T18:30:00Z"); // 00:00 IST Aug 27
    const next = nextRunAfter(def("r").cron, after);
    // 0 7 * * * Asia/Kolkata → 07:00 IST == 01:30 UTC the NEXT day
    expect(next!.toISOString()).toBe("2026-08-27T01:30:00.000Z");
  });

  test("dueTicksBetween counts exactly what fired while we were gone", () => {
    const ticks = dueTicksBetween(
      "*/15 * * * *",
      D("2026-08-27T10:00:00Z"),
      D("2026-08-27T11:00:00Z"),
    );
    // 10:15/10:30/10:45 — 10:00 is EXCLUDED because `from` is last_run_at itself
    expect(ticks.length).toBe(3);
    expect(ticks[0]!.toISOString()).toBe("2026-08-27T10:15:00.000Z");
  });
});

describe("reboot catch-up", () => {
  test("DoD: VM reboot mid-routine → catch-up executes ONCE and is flagged late", async () => {
    const store = memoryStore();
    const engine = new RoutineEngine(store, [
      { name: "disk", run: async () => ({ ok: true }) },
    ]);
    const r = def("sweep");

    // It ran fine Tuesday 07:00 IST.
    await store.put({
      def: r,
      state: { last_run_at: "2026-08-25T02:00:00.000Z", next_run_at: "2026-08-26T01:30:00.000Z" },
      seen_hashes: {},
    });
    // VM died; boots Wednesday 09:47 IST — missed TWO ticks (Wed+Thu? no: Wed's only).
    const now = D("2026-08-26T04:17:00.000Z");

    const decision = await engine.reconcileOnBoot(r, now);
    expect(decision.run).toBe(true);
    expect(decision.kind).toBe("catchup-late");
    expect(decision.missedTicks).toBe(1);
    // Window (Tue 07:00 IST, Wed 09:47 IST) contains exactly ONE tick: Wed 07:00 IST.

    // A SECOND reconcile on the same boot does NOT re-fire (state advanced by markRunComplete).
    await engine.markRunComplete(r.id, now, decision.next ?? undefined);
    const secondBoot = await engine.reconcileOnBoot(r, D("2026-08-26T05:00:00.000Z"));
    expect(secondBoot.run).toBe(false);
    expect(secondBoot.skipReason).toBe("nothing-missed");
  });

  test("brand-new routine catches up nothing on first boot", async () => {
    const engine = new RoutineEngine(memoryStore());
    const d = await engine.reconcileOnBoot(def("fresh"), D("2026-08-27T03:00:00.000Z"));
    expect(d.run).toBe(false);
    expect(d.skipReason).toBe("nothing-missed");
  });
});

describe("preflight gate", () => {
  test("DoD: preflight failure notifies-and-skips WITHOUT consuming the slot", async () => {
    const store = memoryStore();
    let budgetLeft = 0;
    const engine = new RoutineEngine(store, [
      { name: "budget", run: async () => ({ ok: budgetLeft > 0, reason: `only $${budgetLeft}` }) },
      { name: "provider", run: async () => ({ ok: true }) },
    ]);
    const r = def("broke");
    await store.put({
      def: r,
      state: { last_run_at: "2026-08-26T01:31:00.000Z", next_run_at: null },
      seen_hashes: {},
    });
    const now = D("2026-08-27T02:00:00.000Z"); // Thursday, past the daily tick

    const d = await engine.reconcileOnBoot(r, now);
    expect(d.run).toBe(false);
    expect(d.skipReason).toContain("preflight:budget");

    const stored = await store.get("broke");
    expect(stored!.state.last_run_at).toBe("2026-08-26T01:31:00.000Z"); // untouched!

    // Budget topped up → slot STILL available for its catch-up, not burned.
    budgetLeft = 5;
    const retry = await engine.reconcileOnBoot(r, now);
    expect(retry.run).toBe(true);
  });

  test("disabled routine skips cleanly and clears next_run_at", async () => {
    const store = memoryStore();
    const off = { ...def("paused"), enabled: false };
    const engine = new RoutineEngine(store);
    const d = await engine.onTick(off, D("2026-08-27T01:30:00.000Z"));
    expect(d.run).toBe(false);
    expect((await store.get("paused"))!.state.next_run_at).toBeNull();
  });
});

describe("incremental zero-model-call runs", () => {
  test("DoD: unchanged sources yield an EMPTY changed set; clearing seen re-runs everything", async () => {
    const gate = new IncrementalGate(memoryStore());
    const sources = {
      "https://ex.dev/feed": "item a\nitem b",
      "https://ex.dev/blog": "post about tea",
    };
    expect(await gate.whichChanged("daily", sources)).toEqual(["https://ex.dev/feed", "https://ex.dev/blog"]);

    await gate.commitSeen("daily", sources);
    expect(await gate.whichChanged("daily", sources)).toEqual([]); // ← zero calls justified

    // Feed gains one item → ONLY that source enters the plan.
    const changed = await gate.whichChanged("daily", { ...sources, "https://ex.dev/feed": "item a\nitem b\nitem c" });
    expect(changed).toEqual(["https://ex.dev/feed"]);

    // Operator clears seen → full re-run demanded.
    await gate.clearSeen("daily");
    expect((await gate.whichChanged("daily", sources)).length).toBe(2);
  });

  test("hashSource is stable and content-sensitive", () => {
    expect(hashSource("abc")).toBe(hashSource("abc"));
    expect(hashSource("abc")).not.toBe(hashSource("abd"));
  });
});

describe("notify policies", () => {
  test("matrix matches §4.6 defaults", () => {
    expect(shouldNotify("always", "run-done")).toBe(true);
    expect(shouldNotify("on-approval-only", "approval-waiting")).toBe(true);
    expect(shouldNotify("on-approval-only", "run-done")).toBe(false);
    expect(shouldNotify("silent-until-done", "approval-waiting")).toBe(false);
    expect(shouldNotify("silent-until-done", "run-done")).toBe(true);
    expect(shouldNotify("always", "preflight-failed")).toBe(true);
  });
});
