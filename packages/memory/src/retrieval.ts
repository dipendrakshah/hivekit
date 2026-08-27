/**
 * Retrieval assembler (§4.8.3) — the single biggest lever against dilution:
 * MEMORY SIZE IS DECOUPLED FROM PROMPT SIZE. Pinned and State always load;
 * Rules and Facts are scope-matched and capped at rules_top_k / facts_top_n.
 * Everything retrieved is recorded in the ledger against the entry.
 */
import { allEntries } from "./mdfile";
import type { FactEntry, LedgerRow, MemOp, ParsedMemory, RuleEntry } from "./types";

/** Parse a scope expression like `source=example.dev connector=feed` into a map. */
export function parseScope(expr: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of expr.split(/[\s,]+/)) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * Entry scope matches when every key=value in the entry's `when` also appears
 * in the job scope with an equal value (`*` wildcard allowed). An entry with
 * NO scope constraint matches any job.
 */
export function scopeMatches(entryScope: string, jobScope: Record<string, string>): boolean {
  const needed = parseScope(entryScope);
  return Object.entries(needed).every(
    ([k, v]) => v === "*" || jobScope[k] === v,
  );
}

function ruleFreshness(r: RuleEntry): number {
  // Rank primary by confirmations, secondary by recency of use (older/never lower).
  const recency = r.lastUsedAt ? new Date(r.lastUsedAt).getTime() : 0;
  return r.confirmations * 1e13 + Math.min(recency, 1e12);
}

export interface AssembleOptions {
  /** What this job touches: connector, source domain, artifact kind, routine name. */
  scope: Record<string, string>;
  jobId: string;
  run: number;
  now?: Date;
}

export interface Assembled {
  /** The block rendered into the MASTER prompt only. Workers never receive it. */
  promptBlock: string;
  pinnedExceededBudget: boolean;
  retrieved: string[];
}

export function assemble(mem: ParsedMemory, opts: AssembleOptions, config: { pinned_max_bytes: number; rules_top_k: number; facts_top_n: number }): Assembled {
  const now = opts.now ?? new Date();
  const retrieved: string[] = [];

  const pinnedText = mem.pinned.map((p) => `- [${p.id}] ${p.text} ·op ${p.on}`).join("\n");
  const pinnedBytes = Buffer.byteLength(pinnedText, "utf8");
  const pinnedExceededBudget = pinnedBytes > config.pinned_max_bytes;

  // Facts must be unexpired at assembly time.
  const liveFacts = mem.facts.filter((f) => !f.expires || new Date(f.expires).getTime() >= now.getTime());
  const scopedRules = [...mem.rules]
    .filter((r) => scopeMatches(r.when, opts.scope))
    .sort((a, b) => ruleFreshness(b) - ruleFreshness(a))
    .slice(0, config.rules_top_k);
  const scopedFacts = liveFacts
    .filter((f) => scopeMatches(f.when, opts.scope))
    .slice(0, config.facts_top_n);

  retrieved.push(...scopedRules.map((r) => r.id), ...scopedFacts.map((f) => f.id));

  const lines: string[] = [];
  if (mem.pinned.length) {
    lines.push("## Memory — Pinned", pinnedText);
  }
  if (scopedRules.length) {
    lines.push(
      "## Memory — Rules",
      ...scopedRules.map((r) =>
        `- [${r.id}] ${r.text}\n       ·when ${r.when} ·wrong-if ${r.wrongIf} ·confirmed ${r.confirmations}`,
      ),
    );
  }
  if (scopedFacts.length) {
    lines.push(
      "## Memory — Facts",
      ...scopedFacts.map((f) => {
        const bits = [f.provenance ? `·derived (${f.provenance})` : "", f.expires ? `·expires ${f.expires}` : ""].filter(Boolean);
        return `- [${f.id}] ${f.text}\n       ${bits.join(" ")}`;
      }),
    );
  }
  if (Object.keys(mem.state).length) {
    lines.push("## Memory — State", "```json", JSON.stringify(mem.state), "```");
  }

  const promptBlock = lines.join("\n");
  return { promptBlock, pinnedExceededBudget, retrieved };
}

/** Record one ledger row per retrieved entry — retirement evidence lives here. */
export function recordRetrievals(store: { recordLedger(row: LedgerRow): void }, assemb: Assembled, opts: AssembleOptions): void {
  for (const id of assemb.retrieved) {
    store.recordLedger({ kind: "retrieval", entry_id: id, run: opts.run, job_id: opts.jobId, scope: JSON.stringify(opts.scope), at: new Date().toISOString() });
  }
}

// --------------------------------------------------------------------- decay

/**
 * Decay (§4.8.6 tier table): retire Rules unused for
 * `retire_unused_after_runs`; expire Facts on TTL (facts simply drop out of
 * retrieval above; explicit retirement keeps archive evidence).
 *
 * Returns ids retired because of disuse so callers can announce them.
 */
export function retireUnusedRules(
  store: {
    load(): ParsedMemory;
    apply(jobId: string, ops: MemOp[], run?: number, by?: string): unknown;
    lastUsedRun(entryId: string): number | null;
    createdRun(entryId: string): number | null;
    config(): { retire_unused_after_runs: number };
  },
  currentRun: number,
): string[] {
  const threshold = store.config().retire_unused_after_runs;
  const retired: string[] = [];
  const ops: Extract<import("./types").MemOp, { op: "retire" }>[] = [];
  for (const e of allEntries(store.load())) {
    if (e.tier !== "rules") continue;
    const lastUse = store.lastUsedRun(e.id) ?? store.createdRun(e.id) ?? currentRun;
    if (currentRun - lastUse > threshold) {
      ops.push({ op: "retire", id: e.id, reason: `unused for ${currentRun - lastUse} runs (> ${threshold})` });
      retired.push(e.id);
    }
  }
  if (ops.length) {
    store.apply(`decay-run-${currentRun}`, ops, currentRun, "decay");
  }
  return retired;
}

/** Facts past their TTL, with provenance preserved — reported before dropping. */
export function expiredFacts(mem: ParsedMemory, now: Date = new Date()): FactEntry[] {
  return mem.facts.filter((f) => f.expires && new Date(f.expires).getTime() < now.getTime());
}
