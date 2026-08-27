/**
 * Memory types — ARCHITECTURE §4.8.2 tiers, §4.8.5 typed operations.
 *
 * Entries are immutable. A changed belief is a supersede(id), never an edit.
 * Workers never read or write memory; only the master and the operator touch
 * this module.
 */

export type Tier = "pinned" | "rules" | "facts";

export interface RuleEntry {
  tier: "rules";
  id: string;
  text: string;
  /** Scope that retrieves this rule, e.g. `source=example.dev connector=feed`. Empty = always. */
  when: string;
  /** What would show this rule false — required so it can be retired mechanically. */
  wrongIf: string;
  confirmations: number;
  usedCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface FactEntry {
  tier: "facts";
  id: string;
  text: string;
  /** Scope that retrieves this fact, e.g. `source=example.dev`. Empty = always. */
  when: string;
  /** Mandatory when derived from untrusted content (a fetched page / email). */
  provenance: string | null;
  /** ISO date after which the fact is dropped from retrieval. */
  expires: string | null;
  createdAt: string;
}

export interface PinnedEntry {
  tier: "pinned";
  id: string;
  text: string;
  addedBy: string;
  on: string;
}

export type Entry = PinnedEntry | RuleEntry | FactEntry;

export interface StateSection {
  [key: string]: unknown;
}

export interface ParsedMemory {
  pinned: PinnedEntry[];
  rules: RuleEntry[];
  facts: FactEntry[];
  state: StateSection;
}

/** Candidate rows live in memory/candidates.jsonl — never enter a prompt (§4.8.4).
 * Promoted candidates are RETAINED with `consumed_by` set: `memory why` reads
 * their seen_in_jobs as provenance ("produced by job …"). */
export interface CandidateRow {
  id: string;
  text: string;
  scope: string | null;
  /** Job ids that independently observed a near-identical thing (dedupe key). */
  seen_in_jobs: string[];
  created_by: string;
  created_at: string;
  /** Rule id if promoted; retired candidates keep their history here too. */
  consumed_by?: string;
}

/** Archive rows — the ORIGINAL wording is preserved verbatim, never edited (§4.8.5). */
export interface ArchiveRow {
  id: string;
  tier: Tier;
  text: string;
  reason: string;
  archived_by: string;
  archived_at: string;
}

/**
 * Ledger rows — retrievals (against an entry, with the run number), lifecycle
 * events, and hold-out audits (§4.8.3, §4.8.6). This is what makes `memory why`
 * name jobs instead of vibes, and retirement evidence-based rather than guesswork.
 */
export type LedgerRow =
  | { kind: "created"; entry_id: string; run: number; job_id: string; at: string }
  | { kind: "promoted"; entry_id: string; candidate_id: string; run: number; job_id: string; at: string }
  | { kind: "superseded"; entry_id: string; replaced_by: string; run: number; job_id: string; at: string }
  | { kind: "retired"; entry_id: string; reason: string; at: string }
  | { kind: "pinned"; entry_id: string; by: string; at: string }
  | { kind: "retrieval"; entry_id: string; run: number; job_id: string; scope: string; at: string }
  | { kind: "job_write"; job_id: string; ops: number; at: string }
  | {
      kind: "audit";
      run: number;
      on: AuditMetrics;
      off: AuditMetrics;
      verdict: "memory-wins" | "tie" | "memory-off-wins";
      at: string;
    };

export interface AuditMetrics {
  approval_rate: number;
  operator_edits: number;
  retries: number;
  cost_usd: number;
}

/** Typed write path (§4.8.5) — the master drafts these, never free text. */
export type MemOp =
  | { op: "add-candidate"; text: string; scope?: string }
  | { op: "promote"; candidate_id: string; when: string; wrong_if: string }
  | { op: "supersede"; supersedes: string; text: string; tier: "rules" | "facts"; when?: string; wrong_if?: string; provenance?: string; ttl_days?: number; untrusted?: boolean }
  | { op: "retire"; id: string; reason: string }
  | { op: "update-state"; patch: Record<string, unknown> };

export interface MemoryConfig {
  pinned_max_bytes: number;
  rules_top_k: number;
  facts_top_n: number;
  promote_after: number;
  retire_unused_after_runs: number;
  default_fact_ttl_days: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  pinned_max_bytes: 1024,
  rules_top_k: 8,
  facts_top_n: 4,
  promote_after: 3,
  retire_unused_after_runs: 30,
  default_fact_ttl_days: 90,
};

/** Guard failures carry a code so callers can render precise cards (§4.8.5 step 2). */
export class WriteError extends Error {
  constructor(
    readonly code:
      | "rule-missing-when"
      | "rule-missing-wrong-if"
      | "fact-no-ttl-no-provenance"
      | "untrusted-fact-without-provenance"
      | "contradiction-needs-supersede"
      | "near-duplicate"
      | "pinned-immutable"
      | "promotion-insufficient-confirmations"
      | "candidate-not-found"
      | "entry-not-found"
      | "one-write-per-job",
    message: string,
  ) {
    super(message);
    this.name = "WriteError";
  }
}
