/**
 * Shared test seeding helpers — strictly through the PUBLIC API, because
 * bypassing it would silently rot if guards change.
 */
import type { MemoryStore } from "../src/store";

let SEQ = 0;

/** Honest observation loop: N distinct-job add-candidates for identical text. */
export function observeNTimes(
  store: MemoryStore,
  text: string,
  times: number,
  prefix = "obs",
): { id: string } {
  const tag = `${prefix}-${SEQ++}`;
  for (let i = 0; i < times; i++) {
    store.apply(`${tag}-${i}`, [{ op: "add-candidate", text }]);
  }
  const cand = store.candidates().find((c) => c.text === text);
  if (!cand) throw new Error(`candidate missing after ${times} observations`);
  return cand;
}

export function seedRuleAt(store: MemoryStore, opts: { text?: string; when?: string; wrong_if?: string } = {}): { id: string } {
  const text = opts.text ?? "read footnotes on example dev pages for breaking changes";
  const cand = observeNTimes(store, text, store.config().promote_after, `sr`);
  store.apply(`promote-${cand.id}`, [
    {
      op: "promote",
      candidate_id: cand.id,
      when: opts.when ?? "source=example.dev",
      wrong_if: opts.wrong_if ?? "a breaking change appears in the body only",
    },
  ]);
  return { id: store.load().rules.at(-1)!.id };
}

export function seedFactAt(store: MemoryStore): { id: string } {
  // A sacrificial rule with UNIQUE text (store may already contain the default).
  const rule = seedRuleAt(store, { text: `sacrificial fact carrier ${SEQ++}: cadence of example dev digests` });
  store.apply(`fact-from-${rule.id}`, [
    { op: "supersede", supersedes: rule.id, text: "the feed publishes biweekly digests", tier: "facts", when: "source=example.dev", provenance: "https://example.dev/feed", ttl_days: 90 },
  ]);
  return { id: store.load().facts.at(-1)!.id };
}

// Distinct-domain seeds: token-sets barely overlap, keeping every pairwise
// Jaccard far below the dedupe band (>0.75 merges). Single-char tokens are
// ignored by the similarity tokenizer, hence the zero-padded mNNN markers.
const VA = ["feed", "inbox", "archive", "sitemap", "headers", "authors", "releases", "changelog", "manifests", "routing", "redirects", "sitemaps", "labels"];
const VB = ["scrape", "digest", "diff", "tag", "queue", "render", "trim", "audit"];
const VC = ["layout", "prices", "slugs", "metadata", "captions"];

/** Seed `count` genuinely DISTINCT Rules.
 *
 * Safety math: any two texts share at most 2 content tokens (the anchor +
 * one vocab coin flip) out of ~9 → Jaccard ≤ ~0.25, comfortably below
 * CONTRADICT_FROM(0.45). Zero-padded mNNN markers survive the >1-char
 * tokenizer filter and are unique per entry.
 */
export function seedNRules(store: MemoryStore, count: number): void {
  const idOf = (i: number) => `m${String(i).padStart(3, "0")}`;
  for (let i = 0; i < count; i++) {
    const text = `record ${VA[(i * 5) % VA.length]} ${VB[(i * 3 + 1) % VB.length]} ${VC[(i * 2 + 1) % VC.length]} ${idOf(i)}`;
    seedRuleAt(store, { text, wrong_if: `${idOf(i)} treated inversely`, when: "source=example.dev" });
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
