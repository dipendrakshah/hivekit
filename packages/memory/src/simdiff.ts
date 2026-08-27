/**
 * Text similarity and a minimal line diff.
 *
 * Guards (§4.8.5 step 2) need deterministic similarity: near-duplicate rejects,
 * and "contradicts an active entry without supersede" is approximated by
 * high token overlap within the same scope. Thresholds live in one place so
 * they can be tuned against the malformed-output corpus later.
 */

const STOP = new Set([
  "a","an","the","is","are","was","were","be","been","to","of","in","on","for","with",
  "and","or","not","no","it","its","this","that","these","those","as","at","by","from",
  "when","if","do","does","did","use","used","always","never","should","would",
]);

export function tokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  return new Set(words);
}

/** Jaccard over content tokens: |A∩B| / |A∪B| ∈ [0,1]. */
export function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Similarity bands:
 *   ≥ DEDUPE_AT        — same observation reworded; reject as near-duplicate
 *   CONTRADICT_FROM..DEDUPE_AT — plausibly contradicts/conflicts; require explicit supersede(id)
 *   below              — independent, allowed
 */
export const DEDUPE_AT = 0.75;
export const CONTRADICT_FROM = 0.45;

// ---------------------------------------------------------------------------
// Line diff (unified-ish, no dependency): longest-common-subsequence based.
// Memory files are small; O(n·m) is fine.
// ---------------------------------------------------------------------------

export type DiffRow =
  | { kind: "ctx"; text: string }
  | { kind: "del"; text: string }
  | { kind: "add"; text: string };

export function diffLines(before: string, after: string): DiffRow[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  // LCS table. For large memories skip the naive table via the cheap path:
  // identical prefixes/suffixes are trimmed first, which covers append-heavy
  // writes entirely.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n - 1;
  let endB = m - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);

  if (midA.length * midB.length > 4_000_000) {
    // Pathological input; degrade to replace-block rather than hang.
    return [
      ...a.slice(0, start).map((t) => ({ kind: "ctx", text: t }) as DiffRow),
      ...midA.map((t) => ({ kind: "del", text: t }) as DiffRow),
      ...midB.map((t) => ({ kind: "add", text: t }) as DiffRow),
      ...a.slice(endA + 1).map((t) => ({ kind: "ctx", text: t }) as DiffRow),
    ];
  }

  const dp: Uint32Array[] = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
  for (let i = midA.length - 1; i >= 0; i--)
    for (let j = midB.length - 1; j >= 0; j--)
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const rows: DiffRow[] = [];
  for (let k = 0; k < start; k++) rows.push({ kind: "ctx", text: a[k] });
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      rows.push({ kind: "ctx", text: midA[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: "del", text: midA[i++] });
    } else {
      rows.push({ kind: "add", text: midB[j++] });
    }
  }
  while (i < midA.length) rows.push({ kind: "del", text: midA[i++] });
  while (j < midB.length) rows.push({ kind: "add", text: midB[j++] });
  for (let k = endA + 1; k < n; k++) rows.push({ kind: "ctx", text: a[k] });
  return rows;
}

/** Compact unified-style rendering suitable for posting into a thread. */
export function renderDiff(rows: DiffRow[], maxRows = 40): string {
  const out: string[] = ["```diff"];
  let shown = 0;
  let skipped = 0;
  // Context rows are noise in a card; show only changed lines.
  for (const r of rows) {
    if (r.kind === "ctx") continue;
    if (shown >= maxRows) {
      skipped++;
      continue;
    }
    out.push(`${r.kind === "add" ? "+" : "-"} ${r.text}`);
    shown++;
  }
  if (skipped) out.push(`… ${skipped} more change(s) elided`);
  out.push("```");
  if (out.length === 2) out.splice(1, 0, "(no changes)");
  return out.join("\n");
}
