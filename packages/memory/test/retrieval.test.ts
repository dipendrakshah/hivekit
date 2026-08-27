/**
 * Retrieval (§4.8.3) + decay tests.
 * Headline DoD: PROMPT SIZE IS FLAT IN MEMORY SIZE.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { MemoryStore } from "../src/store";
import { assemble, recordRetrievals, retireUnusedRules, expiredFacts, parseScope, scopeMatches } from "../src/retrieval";
import type { MemoryConfig } from "../src/types";
import { seedRuleAt, seedFactAt, seedNRules } from "./helpers";

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "hkret-")), "threads");
  mkdirSync(join(dir, "demo"), { recursive: true });
  mkdirSync(join(dir, "big"), { recursive: true });
});

afterEach(() => {
  rmSync(dir.split("/threads")[0], { recursive: true, force: true });
});

describe("scope matching", () => {
  test("parseScope + wildcard + key/value equality", () => {
    const job = parseScope("source=example.dev connector=feed");
    expect(scopeMatches("source=example.dev", job)).toBe(true);
    expect(scopeMatches("", job)).toBe(true);
    expect(scopeMatches("source=*", job)).toBe(true);
    expect(scopeMatches("source=inbox.example", job)).toBe(false);
    expect(scopeMatches("connector=email", job)).toBe(false);
  });
});

describe("DoD: prompt size is flat in memory size", () => {
  test("a thread with 400+ entries and one with a handful produce prompts within 10%", () => {
    // Caps do the work: rules_top_k(8) + facts_top_n(4) bound the block size,
    // so retrieval volume — and therefore prompt bytes — cannot grow with memory.
    const small = new MemoryStore(join(dir, "small"), { rules_top_k: 8, facts_top_n: 4 });
    seedNRules(small, 12); // DoD scenario: the 12-entry thread

    const big = new MemoryStore(join(dir, "big"), { rules_top_k: 8, facts_top_n: 4 });
    seedNRules(big, 400);

    const scope = { source: "example.dev" };
    const aSmall = assemble(small.load(), { scope, jobId: "probe-small", run: 1 }, small.config());
    const aBig = assemble(big.load(), { scope, jobId: "probe-big", run: 1 }, big.config());

    const lenSmall = Buffer.byteLength(aSmall.promptBlock, "utf8");
    const lenBig = Buffer.byteLength(aBig.promptBlock, "utf8");
    const delta = Math.abs(lenBig - lenSmall) / lenSmall;
    expect(delta).toBeLessThan(0.10);
    // both retrieved exactly the cap (8 rules; no facts seeded)
    expect(aSmall.retrieved.length).toBe(8);
    expect(aBig.retrieved.length).toBe(8);
  });

  test("scope miss yields nothing beyond pinned/state", () => {
    const s = new MemoryStore(join(dir, "miss"), {});
    seedRuleAt(s); // scoped to example.dev
    const a = assemble(s.load(), { scope: { source: "other.dev" }, jobId: "miss-1", run: 1 }, s.config());
    expect(a.retrieved.filter((id) => id.startsWith("r"))).toEqual([]);
    expect(a.promptBlock).not.toMatch(/footnotes/);
  });

  test("DoD: workers are never given MEMORY.md content", () => {
    // Contract pinned for stream 03 review: the ONLY memory renderer is
    // `assemble()`, consumed exclusively by the master loop. No worker-side
    // rendering entry point exists in this package's public surface.
    const indexExports = require("../src/index") as Record<string, unknown>;
    expect(indexExports["renderWorkerPrompt"]).toBeUndefined();
    expect(indexExports["assemble"]).toBeTypeOf("function");
  });
});

describe("ledger + why evidence", () => {
  test("every retrieved entry is recorded against run+job; produced-by names jobs", () => {
    const s = new MemoryStore(join(dir, "led"), {});
    s.apply("sr-o0", [{ op: "add-candidate", text: "read footnotes on example dev pages" }]);
    s.apply("sr-o1", [{ op: "add-candidate", text: "read footnotes on example dev pages" }]);
    s.apply("sr-o2", [{ op: "add-candidate", text: "read footnotes on example dev pages" }]);
    const cand = s.candidates()[0];
    s.apply("promo-job", [
      { op: "promote", candidate_id: cand.id, when: "source=example.dev", wrong_if: "body-only change appears" },
    ]);
    const ruleId = s.load().rules.at(-1)!.id;

    recordRetrievals(
      s,
      assemble(s.load(), { scope: { source: "example.dev" }, jobId: "led-job", run: 42 }, s.config()),
      { scope: { source: "example.dev" }, jobId: "led-job", run: 42 },
    );
    const used = s.jobsThatUsed(ruleId);
    expect(used.length).toBeGreaterThanOrEqual(1);
    expect(used[0].run).toBe(42);
    expect(used[0].job_id).toBe("led-job");

    // why evidence: producer jobs are the three observation jobs
    const produced = s.jobsThatProduced(ruleId);
    for (const j of ["sr-o0", "sr-o1", "sr-o2", "promo-job"]) expect(produced).toContain(j);
  });
});

describe("decay (§4.8.2 eviction)", () => {
  test("DoD: a Rule unused for retire_unused_after_runs is retired automatically and leaves the prompt", () => {
    const s = new MemoryStore(join(dir, "decay"), { retire_unused_after_runs: 5 });
    const rule = seedRuleAt(s);
    recordRetrievals(
      s,
      assemble(s.load(), { scope: { source: "example.dev" }, jobId: "early-use", run: 3 }, s.config()),
      { scope: { source: "example.dev" }, jobId: "early-use", run: 3 },
    );

    const gone = retireUnusedRules(s, 20); // last used run 3 → 17 > 5
    expect(gone).toContain(rule.id);
    expect(s.load().rules.map((r) => r.id)).not.toContain(rule.id);

    const a = assemble(s.load(), { scope: { source: "example.dev" }, jobId: "after-decay", run: 21 }, s.config());
    expect(a.retrieved).not.toContain(rule.id);
    expect(s.archive().at(-1)?.id).toBe(rule.id);
    expect(s.archive().at(-1)?.reason).toMatch(/unused/);
  });

  test("recently-used rules survive decay", () => {
    const s = new MemoryStore(join(dir, "fresh"), { retire_unused_after_runs: 5 });
    const rule = seedRuleAt(s);
    recordRetrievals(
      s,
      assemble(s.load(), { scope: { source: "example.dev" }, jobId: "fresh-use", run: 18 }, s.config()),
      { scope: { source: "example.dev" }, jobId: "fresh-use", run: 18 },
    );
    expect(retireUnusedRules(s, 20)).toEqual([]);
    expect(s.load().rules.map((r) => r.id)).toContain(rule.id);
  });

  test("expired facts drop out of assembly by TTL date", () => {
    const s = new MemoryStore(join(dir, "ttl"), {});
    const fact = seedFactAt(s);
    const entry = s.load().facts.find((f) => f.id === fact.id)!;
    expect(entry.expires).toBeTruthy();

    // Before expiry: retrieved.
    const past = new Date(new Date(entry.expires!).getTime() - 3_600_000);
    const aIn = assemble(s.load(), { scope: { source: "example.dev" }, jobId: "in-ttl", run: 7, now: past }, s.config());
    expect(aIn.retrieved).toContain(fact.id);

    // After expiry: dropped.
    const future = new Date(new Date(entry.expires!).getTime() + 3_600_000);
    expect(expiredFacts(s.load(), future).map((f) => f.id)).toContain(fact.id);
    const aOut = assemble(s.load(), { scope: { source: "example.dev" }, jobId: "out-ttl", run: 8, now: future }, s.config());
    expect(aOut.retrieved).not.toContain(fact.id);
  });
});
