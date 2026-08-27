/**
 * Operator CLI + optional git backing tests.
 * DoD: `hivekit memory why <id>` names the jobs that produced and used the
 * entry — not a summary. DoD: with memory.git, revert restores previous
 * memory and the next job uses it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { MemoryStore } from "../src/store";
import { assemble, recordRetrievals } from "../src/retrieval";
import { GitBacking } from "../src/gitback";
import { runMemoryCli } from "../src/cli";
import { seedRuleAt } from "./helpers";

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "hkcli-")), "threads");
  mkdirSync(join(dir, "demo"), { recursive: true });
});

afterEach(() => {
  rmSync(dir.split("/threads")[0], { recursive: true, force: true });
});

describe("hivekit memory CLI", () => {
  test("DoD: `why` names producing AND consuming jobs concretely", () => {
    const s = new MemoryStore(join(dir, "demo"), {});
    s.apply("produce-job-aaa", [{ op: "add-candidate", text: "cross-check footnotes against release notes" }]);
    s.apply("produce-job-bbb", [{ op: "add-candidate", text: "cross-check footnotes against release notes" }]);
    s.apply("produce-job-ccc", [{ op: "add-candidate", text: "cross-check footnotes against release notes" }]);
    const cand = s.candidates()[0];
    s.apply("promo-job-zzz", [
      { op: "promote", candidate_id: cand.id, when: "source=example.dev", wrong_if: "footnote ignored" },
    ]);
    const ruleId = s.load().rules.at(-1)!.id;
    recordRetrievals(
      s,
      assemble(s.load(), { scope: { source: "example.dev" }, jobId: "consume-job-ddd", run: 9 }, s.config()),
      { scope: { source: "example.dev" }, jobId: "consume-job-ddd", run: 9 },
    );

    const out = runMemoryCli(["why", ruleId], dir);
    expect(out).toContain(ruleId);
    for (const j of ["produce-job-aaa", "produce-job-bbb", "promo-job-zzz"]) expect(out).toContain(j);
    expect(out).toContain("consume-job-ddd");
    expect(out).not.toMatch(/the model believes|likely because/i); // no vibes
  });

  test("pin / retire / candidates round-trip through CLI wording", () => {
    const s = new MemoryStore(join(dir, "demo"), {});
    const rule = seedRuleAt(s);

    // A live FACT (via a second, unique-texted rule superseded into Facts).
    const carrier = seedRuleAt(s, { text: `sacrificial ${Math.random()} cadence line`, when: "source=example.dev", wrong_if: "cadence misread" });
    s.apply(`to-fact-${carrier.id}`, [
      { op: "supersede", supersedes: carrier.id, text: "digests land Tuesdays and Fridays", tier: "facts", when: "source=example.dev", provenance: "https://example.dev/feed", ttl_days: 60 },
    ]);
    const factId = s.load().facts.at(-1)!.id;

    const pinOut = runMemoryCli(["pin", rule.id], dir);
    expect(pinOut).toMatch(/pinned \[/);
    expect(new MemoryStore(join(dir, "demo"), {}).load().pinned.map((p) => p.id)).toContain(rule.id);

    // Retiring the PINNED entry is refused with guidance…
    expect(runMemoryCli(["retire", rule.id, "--reason", "x"], dir)).toMatch(/Pinned entries are removed by editing/);

    // …and retiring the live FACT succeeds with archive evidence.
    expect(runMemoryCli(["retire", factId, "--reason", "wrong direction"], dir)).toMatch(/retired/);
    expect(new MemoryStore(join(dir, "demo"), {}).archive().at(-1)?.reason).toBe("wrong direction");

    expect(runMemoryCli(["why", factId], dir)).toContain("archived:");
  });
});

describe("git backing (§4.8.9)", () => {
  test("DoD: with memory.git on, revert restores the previous memory and the next job uses it", async () => {
    if (!Bun.which("git")) return; // git present in CI/dev; skip-free elsewhere

    const s = new MemoryStore(join(dir, "demo"), {});
    const gb = new GitBacking(dir, true);
    await gb.init();

    // Job A establishes state.
    seedRuleAt(s, { text: "anchor rule from job alpha: check sitemap weekly" });
    await gb.commitThread("demo", "memory after job-alpha");

    // Job B supersedes to a different belief.
    const anchor = s.load().rules.at(-1)!.id;
    s.apply("job-beta", [
      { op: "supersede", supersedes: anchor, text: "check sitemap DAILY per operator feedback", tier: "rules", when: "source=example.dev", wrong_if: "sitemap unchecked" },
    ]);
    const betaState = readFileSync(s.memoryPath, "utf8");
    await gb.commitThread("demo", "memory after job-beta");
    expect(betaState).toContain("DAILY");

    // Operator reverts.
    const hash = await gb.revert("demo");
    expect(hash).toBeTruthy();
    const reverted = readFileSync(s.memoryPath, "utf8");
    expect(reverted).not.toContain("DAILY");
    expect(reverted).toContain("anchor rule from job alpha");

    // And the NEXT JOB uses the restored belief.
    const freshStore = new MemoryStore(join(dir, "demo"), {});
    const a = assemble(freshStore.load(), { scope: { source: "example.dev" }, jobId: "post-revert-job", run: 30 }, freshStore.config());
    expect(a.promptBlock).toContain("anchor rule from job alpha");
    expect(a.promptBlock).not.toContain("DAILY");
  });

  test("disabled backing is a silent no-op", async () => {
    const gb = new GitBacking(dir, false);
    expect(await gb.commitThread("demo", "noop")).toBeNull();
    expect(await gb.revert("demo")).toBeNull();
    expect(gb.isEnabled).toBe(false);
  });
});
