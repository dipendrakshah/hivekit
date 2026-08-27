/**
 * MemoryStore — the whole §4.8 machine minus the agent loop.
 *
 * Owns one thread workspace directory:
 *   <root>/MEMORY.md                 four tiers (source of truth)
 *   <root>/memory/candidates.jsonl   observations waiting for evidence
 *   <root>/memory/archive.jsonl      superseded/retired entries, original wording
 *   <root>/memory/ledger.jsonl       retrievals, lifecycle events, audits
 *
 * The typed write path (§4.8.5): apply(jobId, ops[]) is master-only and
 * once-per-job. It runs in TWO phases — every guard evaluates against a draft
 * first; any rejection aborts the entire batch before a single byte changes on
 * disk, so a rejected write leaves MEMORY.md AND the sidecars byte-identical.
 * Every guard rejection names the offending entry id in its message.
 */
import { mkdirSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, appendJsonl, readJsonl, sweepTempFiles } from "./atomic";
import { allEntries, parseMemory, serializeMemory } from "./mdfile";
import { jaccard, CONTRADICT_FROM, DEDUPE_AT } from "./simdiff";
import {
  DEFAULT_MEMORY_CONFIG,
  WriteError,
  type ArchiveRow,
  type CandidateRow,
  type Entry,
  type LedgerRow,
  type MemOp,
  type ParsedMemory,
  type MemoryConfig,
} from "./types";

export interface ApplyResult {
  before: string;
  after: string;
  /** Human-readable per-op notes, e.g. `promoted r7 after a third confirmation`. */
  notes: string[];
}

type SidecarAppend =
  | { file: "archive.jsonl"; row: ArchiveRow }
  | { file: "ledger.jsonl"; row: LedgerRow };

export class MemoryStore {
  // Getters, not field initializers: with useDefineForClassFields they would
  // evaluate before the `root` parameter property is assigned.
  get memoryPath(): string {
    return join(this.#root, "MEMORY.md");
  }

  get sidecarDir(): string {
    return join(this.#root, "memory");
  }

  #root: string;
  #config: MemoryConfig;
  #mem: ParsedMemory | null = null;
  #stamp = "";

  constructor(root: string, config?: Partial<MemoryConfig>) {
    this.#root = root;
    this.#config = { ...DEFAULT_MEMORY_CONFIG, ...config };
  }

  config(): MemoryConfig {
    return this.#config;
  }

  // ------------------------------------------------------------------ open/load

  ensure(): void {
    mkdirSync(this.sidecarDir, { recursive: true });
    if (!existsSync(this.memoryPath)) {
      atomicWrite(
        this.memoryPath,
        [
          "# Memory",
          "",
          "## Pinned",
          "<!-- operator corrections. authoritative on write, never auto-edited -->",
          "",
          "## Rules",
          "<!-- promoted from candidates. scoped, falsifiable, evidence-tracked -->",
          "",
          "## Facts",
          "<!-- expire by default; provenance required when derived from untrusted content -->",
          "",
          "## State",
          "```json",
          "{}",
          "```",
          "",
        ].join("\n"),
      );
    }
    // An interrupted prior write leaves stray .tmp-* files; sweep on open.
    sweepTempFiles(this.#root, "MEMORY.md");
  }

  load(force = false): ParsedMemory {
    // Sweep stray .tmp-* from an interrupted write on EVERY open — cheap
    // readdir, and "next open recovers" must never depend on file existence.
    sweepTempFiles(this.#root, "MEMORY.md");
    // Cache is validated against the FILE, not trusted blindly: files are the
    // source of truth (§4.8), so out-of-band edits (SSH, another process, the
    // operator CLI) are picked up automatically instead of served stale.
    const stat = existsSync(this.memoryPath)
      ? (require("node:fs").statSync(this.memoryPath) as { size: number; mtimeMs: number })
      : null;
    const stamp = stat ? `${stat.size}:${stat.mtimeMs}` : "";
    if (!this.#mem || force || stamp !== this.#stamp) {
      if (!existsSync(this.memoryPath)) this.ensure();
      this.#mem = parseMemory(readFileSync(this.memoryPath, "utf8"));
      const st = require("node:fs").statSync(this.memoryPath) as { size: number; mtimeMs: number };
      this.#stamp = `${st.size}:${st.mtimeMs}`;
    }
    return this.#mem;
  }

  // ------------------------------------------------------------------ ids

  nextId(prefix: "p" | "r" | "f" | "c"): string {
    let max = 0;
    for (const e of allEntries(this.load())) max = Math.max(max, numOf(e.id));
    for (const c of this.candidates()) max = Math.max(max, numOf(c.id));
    for (const a of this.archive()) max = Math.max(max, numOf(a.id));
    return `${prefix}${max + 1}`;
  }

  findEntry(id: string): Entry | undefined {
    return allEntries(this.load()).find((e) => e.id === id);
  }

  // ------------------------------------------------------------------ sidecars

  candidates(): CandidateRow[] {
    return readJsonl<CandidateRow>(join(this.sidecarDir, "candidates.jsonl"));
  }

  archive(): ArchiveRow[] {
    return readJsonl<ArchiveRow>(join(this.sidecarDir, "archive.jsonl"));
  }

  ledger(): LedgerRow[] {
    return readJsonl<LedgerRow>(join(this.sidecarDir, "ledger.jsonl"));
  }

  // ------------------------------------------------------------------ ledger queries

  /** Which jobs PRODUCED an entry: the distinct jobs whose observations fed it. */
  jobsThatProduced(entryId: string): string[] {
    const jobs = new Set<string>();
    const promoted = this.ledger().find(
      (l) => l.kind === "promoted" && l.entry_id === entryId,
    ) as { candidate_id?: string } | undefined;
    if (promoted?.candidate_id) {
      const cand = this.candidates().find((c) => c.id === promoted.candidate_id);
      cand?.seen_in_jobs.forEach((j) => jobs.add(j));
    }
    for (const l of this.ledger()) {
      if (l.kind !== "retrieval" && "job_id" in l && l.entry_id === entryId && l.job_id)
        jobs.add(l.job_id);
      if (l.kind === "superseded" && "replaced_by" in l && l.replaced_by === entryId)
        jobs.add(l.job_id);
    }
    return [...jobs];
  }

  /** Which jobs USED an entry (retrieved into a prompt), newest run last. */
  jobsThatUsed(entryId: string): Array<{ run: number; job_id: string }> {
    return this.ledger()
      .filter((l) => l.kind === "retrieval" && l.entry_id === entryId)
      .map((l) => ({ run: l.run, job_id: l.job_id }))
      .sort((a, b) => a.run - b.run);
  }

  lastUsedRun(entryId: string): number | null {
    const used = this.jobsThatUsed(entryId);
    return used.length ? Math.max(...used.map((u) => u.run)) : null;
  }

  createdRun(entryId: string): number | null {
    const rows = this.ledger().filter((l) => l.kind === "created" && l.entry_id === entryId);
    return rows.length ? rows.at(-1)!.run : null;
  }

  hasJobWrite(jobId: string): boolean {
    return this.ledger().some((l) => l.kind === "job_write" && l.job_id === jobId);
  }

  audits(): Extract<LedgerRow, { kind: "audit" }>[] {
    return this.ledger().filter((l): l is Extract<LedgerRow, { kind: "audit" }> => l.kind === "audit");
  }

  /** Public ledger append — retrieval rows, audit rows, future kinds. */
  recordLedger(row: LedgerRow): void {
    this.ensure();
    appendJsonl(join(this.sidecarDir, "ledger.jsonl"), row);
  }

  // ------------------------------------------------------------------ the write path

  /**
   * Master-only, once-per-job. Two-phase: validate+draft fully, then commit.
   * Guard failures throw BEFORE any disk change.
   */
  apply(jobId: string, ops: MemOp[], run = 0, by = "master"): ApplyResult {
    if (this.hasJobWrite(jobId)) {
      throw new WriteError("one-write-per-job", `job ${jobId} already applied a memory write`);
    }
    const activeCandidates = this.candidates();
    let candidatesTouched = false;
    const draft: ParsedMemory = structuredClone(this.load());
    const pendingSidecars: SidecarAppend[] = [];
    const notes: string[] = [];

    // Candidates are NOT part of the append stream: every touch rewrites
    // candidates.jsonl wholesale at commit time. A rejected batch therefore
    // also rolls back confirmation bumps automatically.
    const commitCandidates = () => {
      if (candidatesTouched)
        atomicWrite(
          join(this.sidecarDir, "candidates.jsonl"),
          activeCandidates.length
            ? `${activeCandidates.map((c) => JSON.stringify(c)).join("\n")}\n`
            : "",
        );
    };

    const flushSidecars = () =>
      pendingSidecars.forEach(({ file, row }) =>
        appendJsonl(join(this.sidecarDir, file), row),
      );

    try {
      for (const op of ops) {
        switch (op.op) {
          case "add-candidate": {
            const twin = activeCandidates.find((c) => jaccard(c.text, op.text) >= DEDUPE_AT);
            if (twin) {
              if (!twin.seen_in_jobs.includes(jobId)) {
                twin.seen_in_jobs.push(jobId);
                candidatesTouched = true;
              }
              notes.push(`confirmation logged for candidate ${twin.id} (${twin.seen_in_jobs.length} distinct job(s))`);
            } else {
              const row: CandidateRow = {
                id: allocCandidateId(activeCandidates, this),
                text: op.text,
                scope: op.scope ?? null,
                seen_in_jobs: [jobId],
                created_by: by,
                created_at: new Date().toISOString(),
              };
              activeCandidates.push(row);
              candidatesTouched = true;
              notes.push(`candidate ${row.id} logged`);
            }
            break;
          }

          case "promote": {
            const candIdx = activeCandidates.findIndex((c) => c.id === op.candidate_id);
            if (candIdx === -1)
              throw new WriteError("candidate-not-found", `candidate ${op.candidate_id} does not exist`);
            const cand = activeCandidates[candIdx];
            const distinct = cand.seen_in_jobs.length;
            if (distinct < this.#config.promote_after) {
              throw new WriteError(
                "promotion-insufficient-confirmations",
                `promotion of ${cand.id} needs ${this.#config.promote_after} confirmations in DISTINCT jobs; has ${distinct}`,
              );
            }
            assertRuleFields(op.when, op.wrong_if);
            guardAgainstActive(draft, cand.text, "rules", undefined);
            const id = allocEntryId(draft, "rules");
            draft.rules.push({
              tier: "rules",
              id,
              text: cand.text,
              when: op.when,
              wrongIf: op.wrong_if,
              confirmations: distinct,
              usedCount: 0,
              lastUsedAt: null,
              createdAt: new Date().toISOString(),
            });
            pendingSidecars.push({ file: "ledger.jsonl", row: { kind: "promoted", entry_id: id, candidate_id: cand.id, run, job_id: jobId, at: iso() } });
            pendingSidecars.push({ file: "ledger.jsonl", row: { kind: "created", entry_id: id, run, job_id: jobId, at: iso() } });
            // Promotion CONSUMES the candidate but retains the row: `why`
            // reads its seen_in_jobs as provenance. Operator "candidates"
            // listing hides consumed rows.
            cand!.consumed_by = id;
            candidatesTouched = true;
            notes.push(`promoted ${id} after a ${ordinal(distinct)} confirmation`);
            break;
          }

          case "supersede": {
            const old = allEntries(draft).find((e) => e.id === op.supersedes);
            if (!old)
              throw new WriteError("entry-not-found", `entry ${op.supersedes} does not exist`);
            if (old.tier === "pinned")
              throw new WriteError("pinned-immutable", `[${old.id}] is Pinned — only the operator may change it`);
            if (op.tier === "rules") {
              assertRuleFields(op.when ?? "", op.wrong_if ?? "");
            } else {
              assertFactFields(op.provenance ?? null, op.ttl_days, op.untrusted === true);
            }
            // New text must still not collide with OTHER active entries.
            guardAgainstActive(draft, op.text, op.tier, old.id);

            const fresh = freshEntryFrom(op, draft);
            removeFromDraft(draft, old);
            pendingSidecars.push({
              file: "archive.jsonl",
              row: { id: old.id, tier: old.tier, text: old.text, reason: `superseded-by:${fresh.id}`, archived_by: by, archived_at: iso() },
            });
            pushIntoDraft(draft, fresh);
            pendingSidecars.push({ file: "ledger.jsonl", row: { kind: "superseded", entry_id: old.id, replaced_by: fresh.id, run, job_id: jobId, at: iso() } });
            pendingSidecars.push({ file: "ledger.jsonl", row: { kind: "created", entry_id: fresh.id, run, job_id: jobId, at: iso() } });
            notes.push(`${old.id} superseded by ${fresh.id}`);
            break;
          }

          case "retire": {
            const victim = allEntries(draft).find((e) => e.id === op.id);
            if (!victim)
              throw new WriteError("entry-not-found", `entry ${op.id} does not exist`);
            if (victim.tier === "pinned")
              throw new WriteError("pinned-immutable", `[${victim.id}] is Pinned — only the operator may change it`);
            removeFromDraft(draft, victim);
            pendingSidecars.push({
              file: "archive.jsonl",
              row: { id: victim.id, tier: victim.tier, text: victim.text, reason: op.reason, archived_by: by, archived_at: iso() },
            });
            pendingSidecars.push({ file: "ledger.jsonl", row: { kind: "retired", entry_id: victim.id, reason: op.reason, at: iso() } });
            notes.push(`retired ${victim.id}: ${op.reason}`);
            break;
          }

          case "update-state": {
            draft.state = { ...draft.state, ...structuredClone(op.patch) };
            notes.push(`state updated (${Object.keys(op.patch).join(", ")})`);
            break;
          }
        }
      }
    } catch (err) {
      // Two-phase discipline: nothing was flushed; memory + sidecars untouched.
      throw err;
    }

    const before = readFileSync(this.memoryPath, "utf8");
    const after = serializeMemory(draft);
    atomicWrite(this.memoryPath, after);
    flushSidecars();
    commitCandidates();
    if (ops.length > 0)
      appendJsonl(join(this.sidecarDir, "ledger.jsonl"), { kind: "job_write", job_id: jobId, ops: ops.length, at: iso() } satisfies LedgerRow);
    this.#mem = draft;
    return { before, after, notes };
  }

  // ------------------------------------------------------------------ operator actions

  /** Operator vouches for it — straight to Pinned, id preserved (§4.8.4). */
  pin(id: string, by: string): { id: string; text: string; was: "rules" | "facts" } | null {
    const victim = this.findEntry(id);
    if (!victim || victim.tier === "pinned") return null;
    const mem = this.load();
    const was = victim.tier;
    removeFromDraft(mem, victim);
    mem.pinned.push({ tier: "pinned", id, text: victim.text, addedBy: by, on: iso().slice(0, 10) });
    atomicWrite(this.memoryPath, serializeMemory(mem));
    appendJsonl(join(this.sidecarDir, "ledger.jsonl"), { kind: "pinned", entry_id: id, by, at: iso() } satisfies LedgerRow);
    return { id, text: victim.text, was };
  }

  retireByOperator(id: string, reason: string, by: string): boolean {
    const victim = this.findEntry(id);
    if (!victim || victim.tier === "pinned") return false;
    const mem = this.load();
    removeFromDraft(mem, victim);
    atomicWrite(this.memoryPath, serializeMemory(mem));
    appendJsonl(join(this.sidecarDir, "archive.jsonl"), {
      id: victim.id,
      tier: victim.tier,
      text: victim.text,
      reason,
      archived_by: by,
      archived_at: iso(),
    } satisfies ArchiveRow);
    appendJsonl(join(this.sidecarDir, "ledger.jsonl"), { kind: "retired", entry_id: victim.id, reason, at: iso() } satisfies LedgerRow);
    return true;
  }
}

// --------------------------------------------------------------------- guards

function assertRuleFields(when: string, wrongIf: string): void {
  if (!when?.trim())
    throw new WriteError("rule-missing-when", "a Rule without `when` cannot be retrieved by scope — it is not a rule");
  if (!wrongIf?.trim())
    throw new WriteError("rule-missing-wrong-if", "a Rule without `wrong-if` is unfalsifiable — it is a preference, not a rule");
}

function assertFactFields(provenance: string | null, ttlDays?: number, untrusted = false): void {
  if (untrusted && !provenance)
    throw new WriteError("untrusted-fact-without-provenance", "a Fact derived from UNTRUSTED content requires provenance (§4.8.7)");
  if (!provenance && !ttlDays)
    throw new WriteError("fact-no-ttl-no-provenance", "a Fact requires either a TTL or provenance");
}

/** Near-duplicate and contradiction checks against currently-active entries. */
function guardAgainstActive(draft: ParsedMemory, text: string, tier: "rules" | "facts", exceptId?: string): void {
  for (const e of allEntries(draft)) {
    if (exceptId && e.id === exceptId) continue;
    const sim = jaccard(e.text, text);
    if (sim >= DEDUPE_AT) {
      throw new WriteError("near-duplicate", `near-duplicate of [${e.id}] "${clip(e.text)}" — restate it or supersede ${e.id}`);
    }
    if (sim >= CONTRADICT_FROM && e.tier === tier) {
      throw new WriteError(
        "contradiction-needs-supersede",
        `conflicts with [${e.id}] "${clip(e.text)}" — call supersede(${e.id}) instead`,
      );
    }
  }
}

// --------------------------------------------------------------------- helpers

function removeFromDraft(mem: ParsedMemory, entry: Entry): void {
  if (entry.tier === "pinned") mem.pinned = mem.pinned.filter((p) => p.id !== entry.id);
  else if (entry.tier === "rules") mem.rules = mem.rules.filter((r) => r.id !== entry.id);
  else mem.facts = mem.facts.filter((f) => f.id !== entry.id);
}

function pushIntoDraft(mem: ParsedMemory, entry: Entry): void {
  if (entry.tier === "rules") {
    mem.rules.push(entry);
  } else if (entry.tier === "facts") {
    mem.facts.push(entry);
  } else {
    throw new Error("pushIntoDraft: pinned entries enter only via pin()");
  }
}

/** Fresh entry built from a supersede op; guard-validated BEFORE this is called. */
function freshEntryFrom(
  op: Extract<MemOp, { op: "supersede" }>,
  draft: ParsedMemory,
): Entry {
  const now = iso();
  const id = allocEntryId(draft, op.tier);
  if (op.tier === "rules") {
    return {
      tier: "rules",
      id,
      text: op.text,
      when: op.when ?? "",
      wrongIf: op.wrong_if ?? "",
      confirmations: 1,
      usedCount: 0,
      lastUsedAt: null,
      createdAt: now,
    };
  }
  return {
    tier: "facts",
    id,
    text: op.text,
    when: op.when ?? "",
    provenance: op.provenance ?? null,
    expires: op.ttl_days ? dateIn(op.ttl_days) : null,
    createdAt: now,
  };
}

function allocEntryId(mem: ParsedMemory, tier: "rules" | "facts"): string {
  const prefix = tier === "rules" ? "r" : "f";
  let max = 0;
  for (const e of allEntries(mem)) max = Math.max(max, numOf(e.id));
  return `${prefix}${max + 1}`;
}

function allocCandidateId(existing: CandidateRow[], store?: { ledger(): LedgerRow[] }): string {
  // Ids are lifetime-monotonic: consumed candidates stay burned, so scan
  // ledger 'promoted' rows too and never hand out a used number.
  let max = 0;
  for (const c of existing) max = Math.max(max, numOf(c.id));
  if (store) {
    for (const l of store.ledger())
      if (l.kind === "promoted") max = Math.max(max, numOf(l.candidate_id));
  }
  return `c${max + 1}`;
}

function clip(s: string, n = 48): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function numOf(id: string): number {
  return Number.parseInt(id.replace(/^[a-z]+/, ""), 10) || 0;
}

function iso(): string {
  return new Date().toISOString();
}

function dateIn(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
