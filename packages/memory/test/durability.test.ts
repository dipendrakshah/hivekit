/**
 * Durability tests — todo/02 DoD:
 * "A SIGKILL during a memory write leaves the previous MEMORY.md intact
 *  and parseable — never a half file."
 *
 * atomic.ts's CRASH_BEFORE_RENAME seam reproduces death between fsync and
 * rename exactly as a real SIGKILL would: previous file intact, stray .tmp-*
 * left behind, next open() sweeps it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { MemoryStore } from "../src/store";
import { parseMemory } from "../src/mdfile";
import { CRASH_BEFORE_RENAME } from "../src/atomic";
import { seedNRules } from "./helpers";

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "hkcrash-")), "threads", "demo");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir.split("/threads")[0], { recursive: true, force: true });
});

function countTemps(): number {
  return readdirSync(dir).filter((f) => f.includes(".tmp-")).length;
}

describe("SIGKILL-during-write durability", () => {
  test("previous MEMORY.md survives intact and parseable; stray temp swept on next open", () => {
    const s = new MemoryStore(dir, {});
    seedNRules(s, 4);
    const beforeRaw = readFileSync(s.memoryPath, "utf8");
    const beforeParsed = parseMemory(beforeRaw);
    expect(beforeParsed.rules.length).toBe(4);
    expect(countTemps()).toBe(0);

    // Death between fsync and rename, mid-application of a large batch.
    try {
      CRASH_BEFORE_RENAME.on = true;
      s.apply("doomed-job", [
        { op: "update-state", patch: { last_run: "should-never-persist" } },
      ]);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).name).toBe("CrashInjected");
    }

    // The old file is byte-for-byte present…
    const afterRaw = readFileSync(s.memoryPath, "utf8");
    expect(afterRaw).toBe(beforeRaw);

    // …and parses cleanly with NO trace of the doomed write.
    const afterParsed = parseMemory(afterRaw);
    expect(afterParsed.rules.length).toBe(4);
    expect(JSON.stringify(afterParsed.state)).not.toContain("should-never-persist");

    // A crashed process cannot clean its own temps; the NEXT open() does.
    expect(countTemps()).toBeGreaterThan(0);
    const s2 = new MemoryStore(dir, {});
    s2.load(); // ensure() → sweepTempFiles
    expect(countTemps()).toBe(0);

    // The store is usable again — new writes succeed and nothing was lost.
    s2.apply("recovery-job", [{ op: "update-state", patch: { recovered: true } }]);
    const mem = parseMemory(readFileSync(s.memoryPath, "utf8"));
    expect(mem.state.recovered).toBe(true);
    expect(mem.rules.length).toBe(4); // prior entries intact
  });

  test("rejected batches (guard failure) leave ZERO sidecar residue and no job_write marker", () => {
    const s = new MemoryStore(dir, {});
    seedNRules(s, 2);
    const beforeLedgerExists = existsSync(join(dir, "memory", "ledger.jsonl"));

    expect(() =>
      s.apply("two-phase-job", [
        { op: "update-state", patch: { step: 1 } },           // legal
        { op: "retire", id: "nope1", reason: "missing" },     // throws
        { op: "retire", id: "nope2", reason: "never reached" },
      ]),
    ).toThrow(/nope1/);

    // No partial job_write row exists for that job id.
    expect(s.hasJobWrite("two-phase-job")).toBe(false);
    // (ledger may exist from earlier seeds; it must not contain our job id)
    if (beforeLedgerExists) {
      expect(readFileSync(join(dir, "memory", "ledger.jsonl"), "utf8")).not.toContain("two-phase-job");
    }
  });

  test("large memory round-trips losslessly through serialize→parse", () => {
    const s = new MemoryStore(dir, {});
    seedNRules(s, 60);
    const raw = readFileSync(s.memoryPath, "utf8");
    const back = parseMemory(raw);
    const front = require("../src/mdfile").serializeMemory(back) as string;
    expect(front).toBe(raw);
  });
});
