/**
 * Write-path tests: guards, immutability, one-write-per-job, atomicity.
 * Each test names the DoD claim or §4.8.x paragraph it proves.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { MemoryStore } from "../src/store";
import { parseMemory } from "../src/mdfile";
import { WriteError } from "../src/types";

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "hkmem-")), "threads", "demo");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir.split("/threads")[0], { recursive: true, force: true });
});

function fresh(cfg?: Parameters<MemoryStore>[1]): MemoryStore {
  return new MemoryStore(dir, cfg);
}

describe("write path guards (§4.8.5 step 2)", () => {
  test("DoD: a Rule submitted without wrong-if is rejected", () => {
    const s = fresh({ promote_after: 1 });
    s.apply("job-a", [{ op: "add-candidate", text: "verify changelog before summarizing releases" }]);
    const cand = s.candidates()[0];
    expect(() =>
      s.apply("job-b", [{ op: "promote", candidate_id: cand!.id, when: "source=x.dev", wrong_if: "" }]),
    ).toThrow(/wrong-if/);
    // valid rule fields succeed
    s.apply("job-c", [{ op: "add-candidate", text: "double-check published dates on archived posts" }]);
    const ok = s.apply("job-d", [
      { op: "promote", candidate_id: s.candidates().at(-1)!.id, when: "source=x.dev", wrong_if: "a stale date was cited" },
    ]);
    expect(ok.notes.join(" ")).toMatch(/promoted/);
  });

  test("DoD: a Fact without TTL or provenance is rejected", () => {
    const s = fresh();
    const rule = seedRule(s);
    expect(() =>
      s.apply("job-u", [
        { op: "supersede", supersedes: rule.id, text: "example dev posts weekly digest notes", tier: "facts" },
      ]),
    ).toThrow(/TTL|provenance/);
  });

  test("untrusted-derived fact without provenance is rejected (§4.8.7)", () => {
    const s = fresh();
    const rule = seedRule(s);
    expect(() =>
      s.apply("job-untrusted", [
        {
          op: "supersede",
          supersedes: rule.id,
          text: "example dev publishes twice weekly",
          tier: "facts",
          untrusted: true,
        },
      ]),
    ).toThrow(/provenance/i);
  });

  test("DoD: a contradicting write without supersede(id) is rejected AND the message names the conflicting entry", () => {
    const s = fresh({ promote_after: 1 });
    const seeded = seedRule(s);
    s.apply("j1", [{ op: "add-candidate", text: `${seeded.text}, except also read the body` }]);
    const cand = s.candidates()[0];
    try {
      s.apply("j2", [
        { op: "promote", candidate_id: cand!.id, when: "source=example.dev", wrong_if: "body-only change appears" },
      ]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WriteError);
      expect((err as Error).message).toContain(seeded.id);
    }
  });

  test("near-duplicate of an active entry is rejected at promotion, naming it", () => {
    const s = fresh({ promote_after: 1 });
    const rule = seedRule(s);
    s.apply("job-n0", [{ op: "add-candidate", text: "Read footnotes on example dev because changes hide there" }]);
    const cand = s.candidates().at(-1)!;
    expect(() =>
      s.apply("job-n1", [{ op: "promote", candidate_id: cand.id, when: "*", wrong_if: "x" }]),
    ).toThrow(new RegExp(rule.id));
  });

  test("pinned entries are immutable through master ops (§4.8.2 tier table)", () => {
    const s = fresh();
    const fact = seedFact(s);
    const pinned = s.pin(fact.id, "operator");
    expect(pinned).not.toBeNull();
    expect(() =>
      s.apply("job-p1", [{ op: "retire", id: fact.id, reason: "master trying to touch pinned" }]),
    ).toThrow(/Pinned/);
    expect(() =>
      s.apply("job-p2", [
        { op: "supersede", supersedes: fact.id, text: "a replacement line about feed cadence", tier: "facts", provenance: "https://example.dev/feed", ttl_days: 3 },
      ]),
    ).toThrow(/Pinned/);
  });

  test("one write per job: a second apply() with the same jobId is refused", () => {
    const s = fresh();
    s.apply("job-once", [{ op: "update-state", patch: { last_run: "now" } }]);
    expect(() => s.apply("job-once", [{ op: "update-state", patch: { again: true } }])).toThrow(/already applied/);
  });

  test("batch all-or-nothing: failing later op leaves MEMORY.md byte-identical, no job_write row", () => {
    const s = fresh();
    s.load(); // ensure workspace exists
    const beforeBytes = readFileSync(s.memoryPath);
    expect(() =>
      s.apply("job-bad", [
        { op: "update-state", patch: { seen: ["x"] } },
        { op: "retire", id: "r999", reason: "does not exist" },
      ]),
    ).toThrow(/r999/);
    expect(Buffer.from(readFileSync(s.memoryPath)).equals(beforeBytes)).toBe(true);
    expect(s.hasJobWrite("job-bad")).toBe(false);
  });
});

describe("promotion (§4.8.4)", () => {
  test("DoD: one observation never creates a Rule; three DISTINCT jobs promote it", () => {
    const s = fresh({ promote_after: 3 });
    s.apply("obs-1", [{ op: "add-candidate", text: "sweep example dev feed before summarizing" }]);
    // candidate logged…
    expect(s.candidates().length).toBe(1);
    // …and absent from the file tiers
    expect(parseMemory(readFileSync(s.memoryPath, "utf8")).rules.length).toBe(0);

    // restatement inside the SAME run would not count; this is a DIFFERENT
    // job independently landing on the same observation — it confirms.
    s.apply("obs-2-distinct-job", [{ op: "add-candidate", text: "sweep example dev feed before summarizing" }]);
    const candId = s.candidates()[0].id;
    expect(s.candidates().at(-1)!.seen_in_jobs.length).toBe(2);

    // early promote refuses
    expect(() =>
      s.apply("early-job", [{ op: "promote", candidate_id: candId, when: "source=example.dev", wrong_if: "no footnote check happened" }]),
    ).toThrow(/needs 3/);

    s.apply("obs-3rd-job", [{ op: "add-candidate", text: "sweep example dev feed before summarizing" }]);
    const res = s.apply("promo-job", [
      { op: "promote", candidate_id: candId, when: "source=example.dev", wrong_if: "no footnote check happened" },
    ]);
    expect(res.notes.join(" ")).toMatch(/promoted r\d+/);
    expect(s.load().rules.length).toBe(1);
  });
});

describe("immutability + archive (§4.8.5)", () => {
  test("DoD: superseding preserves the original wording in archive.jsonl", () => {
    const s = fresh();
    const rule = seedRule(s);
    const originalText = s.findEntry(rule.id)!.text;
    s.apply("job-s1", [
      { op: "supersede", supersedes: rule.id, text: "Read footnotes on example dev first — they carry release notes", tier: "rules", when: "source=example.dev", wrong_if: "footnote skipped on breaking change" },
    ]);
    const arch = s.archive();
    expect(arch.length).toBe(1);
    expect(arch[0].id).toBe(rule.id);
    expect(arch[0].text).toBe(originalText);
    expect(arch[0].reason).toBe(`superseded-by:${s.load().rules.at(-1)!.id}`);
    expect(s.load().rules.map((r) => r.id)).not.toContain(rule.id);
  });
});

describe("state hygiene", () => {
  test("update-state merges shallowly and round-trips through parse", () => {
    const s = fresh();
    s.apply("job-st1", [{ op: "update-state", patch: { last_run: "t1", seen: ["a"] } }]);
    s.apply("job-st2", [{ op: "update-state", patch: { last_run: "t2" } }]);
    const mem = parseMemory(readFileSync(s.memoryPath, "utf8"));
    expect(mem.state.last_run).toBe("t2");
    expect(mem.state.seen).toEqual(["a"]);
  });

  test("ids allocate monotonically across active tiers and archives", () => {
    const s = fresh();
    const rule = seedRule(s); // r1
    s.apply("job-id1", [{ op: "retire", id: rule.id, reason: "test cleanup" }]);
    const next = s.nextId("r");
    expect(Number.parseInt(next.slice(1))).toBeGreaterThan(Number.parseInt(rule.id.slice(1)));
  });
});

// --------------------------------------------------------------------- seeds

function seedRule(s: MemoryStore): { id: string } {
  s.ensure();
  s.apply("seed-r-obs1", [{ op: "add-candidate", text: "read footnotes on example dev pages for breaking changes" }]);
  s.apply("seed-r-obs2", [{ op: "add-candidate", text: "read footnotes on example dev pages for breaking changes" }]);
  s.apply("seed-r-obs3", [{ op: "add-candidate", text: "read footnotes on example dev pages for breaking changes" }]);
  const cand = s.candidates()[0];
  s.apply("seed-r-promote", [
    { op: "promote", candidate_id: cand.id, when: "source=example.dev", wrong_if: "a breaking change appears in the body only" },
  ]);
  return { id: s.load().rules.at(-1)!.id };
}

function seedFact(s: MemoryStore): { id: string } {
  const rule = seedRule(s);
  s.apply(`seed-f-${rule.id}`, [
    { op: "supersede", supersedes: rule.id, text: "example dev publishes roughly twice a week", tier: "facts", provenance: "https://example.dev/feed", ttl_days: 90 },
  ]);
  return { id: s.load().facts.at(-1)!.id };
}
