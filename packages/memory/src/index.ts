/**
 * @hivekit/memory — tiered thread memory (ARCHITECTURE §4.8, todo/02).
 *
 * Public surface:
 *   MemoryStore            write path + guards + sidecars for one thread dir
 *   assemble               master-prompt assembler (retrieval, never wholesale)
 *   retireUnusedRules      decay pass
 *   GitBacking             optional git history for /data/threads
 *   runMemoryCli           `hivekit memory …`
 *   parseMemory / serializeMemory / diffLines / renderDiff
 */
export { MemoryStore, type ApplyResult } from "./store";
export { assemble, recordRetrievals, retireUnusedRules, expiredFacts, parseScope, scopeMatches } from "./retrieval";
export { GitBacking } from "./gitback";
export { runMemoryCli } from "./cli";
export { parseMemory, serializeMemory, allEntries } from "./mdfile";
export { diffLines, renderDiff, jaccard, DEDUPE_AT, CONTRADICT_FROM } from "./simdiff";
export {
  WriteError,
  DEFAULT_MEMORY_CONFIG,
  type Entry,
  type PinnedEntry,
  type RuleEntry,
  type FactEntry,
  type CandidateRow,
  type ArchiveRow,
  type LedgerRow,
  type MemOp,
  type MemoryConfig,
  type StateSection,
  type AuditMetrics,
} from "./types";
