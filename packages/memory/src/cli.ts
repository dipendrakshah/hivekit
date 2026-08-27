/**
 * `hivekit memory` operator controls (§4.8.8).
 *
 * Usage: runMemoryCli(["show", "--tier", "rules"], threadsDir, config?)
 * Each command prints a plain-text answer meant for an operator terminal;
 * `why` names jobs — not summaries — per the DoD.
 */
import { join } from "node:path";
import { parseMemory } from "./mdfile";
import { MemoryStore } from "./store";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "./types";

export function runMemoryCli(argv: string[], threadsDir: string, config?: Partial<MemoryConfig>): string {
  const [cmd, ...rest] = argv;

  function storeFor(slug?: string): { slug: string; store: MemoryStore } {
    if (!slug) {
      // Pick the most recently modified thread directory.
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      const slugs = readdirSync(threadsDir)
        .filter((s) => statSync(join(threadsDir, s)).isDirectory() && !s.startsWith("."))
        .map((s) => ({ s, m: statSync(join(threadsDir, s)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (!slugs.length) throw new Error(`no thread workspaces under ${threadsDir}`);
      return { slug: slugs[0].s, store: new MemoryStore(join(threadsDir, slugs[0].s), config) };
    }
    return { slug, store: new MemoryStore(join(threadsDir, slug), config) };
  }

  switch (cmd) {
    case "show": {
      const tierIdx = rest.indexOf("--tier");
      const only = tierIdx >= 0 ? rest[tierIdx + 1] : null;
      const { slug, store } = storeFor(rest[0] && !rest[0].startsWith("-") ? rest[0] : undefined);
      const mem = store.load();
      if (only === "pinned" || only === "rules" || only === "facts")
        return serializeTier(mem, only);
      if (only === "state") return JSON.stringify(mem.state, null, 2);
      return `[${slug}]\n${parseMemoryDump(store)}`;
    }

    case "why": {
      const id = rest.find((a) => /^[prf]\d+$/.test(a));
      if (!id) return "usage: hivekit memory why <id>";
      const { slug, store } = storeFor(undefined);
      const entry = store.findEntry(id);
      const archRow = store.archive().find((a) => a.id === id);
      if (!entry && !archRow)
        return `${id}: unknown entry (not active, not in archive.jsonl)`;
      const status = entry
        ? `(active · ${entry.tier})`
        : `(archived as ${archRow!.reason.split(":")[0]} — original wording below)`;
      const lines = [`[${id}] ${status} in thread ${slug}`];
      lines.push(`text: ${entry ? entry.text : archRow!.text}`);
      if (entry?.tier === "rules") {
        lines.push(`when: ${entry.when}`, `wrong-if: ${entry.wrongIf}`);
      }
      const produced = store.jobsThatProduced(id);
      const used = store.jobsThatUsed(id);
      if (produced.length || used.length) {
        lines.push(
          `produced by ${produced.length} job(s): ${produced.join(", ") || "-"}`,
          `used by ${used.length} retrieval(s): ${
            used.map((u) => `${u.job_id} (run ${u.run})`).join(", ") || "-"
          }`,
        );
      }
      if (archRow) lines.push(`archived: ${archRow.reason} at ${archRow.archived_at}`);
      return lines.join("\n");
    }

    case "pin": {
      const id = rest.find((a) => /^[prf]\d+$/.test(a));
      if (!id) return "usage: hivekit memory pin <id>";
      const { store } = storeFor(undefined);
      const res = store.pin(id, "operator");
      return res ? `pinned [${res.id}] to Pinned (was ${res.was}) — you vouch for it.` : `[${id}] not found or already pinned`;
    }

    case "retire": {
      const id = rest.find((a) => /^[prf]\d+$/.test(a));
      const reasonIdx = rest.indexOf("--reason");
      const reason = reasonIdx >= 0 ? rest[reasonIdx + 1] : "retired by operator";
      if (!id) return "usage: hivekit memory retire <id> [--reason ...]";
      const { store } = storeFor(undefined);
      return store.retireByOperator(id, reason, "operator")
        ? `retired [${id}] — original wording preserved in archive.jsonl`
        : `[${id}] not found (Pinned entries are removed by editing MEMORY.md)`;
    }

    case "candidates": {
      const { store } = storeFor(undefined);
      // Only UNCONSUMED candidates are "waiting for evidence".
      const cands = store.candidates().filter((c) => !c.consumed_by);
      if (!cands.length) return "no candidates waiting for evidence";
      return cands
        .map(
          (c) =>
            `[${c.id}] ${c.text}\n       ·seen in ${c.seen_in_jobs.length} distinct job(s): ${c.seen_in_jobs.map((j) => j.slice(0, 8)).join(", ")}`,
        )
        .join("\n");
    }

    case "audit": {
      const { store } = storeFor(undefined);
      const audits = store.audits();
      if (!audits.length) return "no hold-out audits recorded yet";
      return audits
        .slice(-5)
        .map(
          (a) =>
            `run ${a.run} (${a.at}): memory-on approvals ${(a.on.approval_rate * 100).toFixed(0)}% vs off ${(a.off.approval_rate * 100).toFixed(0)}% → ${a.verdict}`,
        )
        .join("\n");
    }

    default:
      return [
        "usage: hivekit memory <command>",
        "",
        "commands:",
        "  show [--tier pinned|rules|facts|state]   render active memory",
        "  why <id>          provenance, confirmations, which jobs used it",
        "  pin <id>          promote to Pinned — you vouch for it",
        "  retire <id>       archive it, with a reason",
        "  candidates        what is waiting for evidence",
        "  audit             hold-out comparisons on record",
      ].join("\n");
  }
}

function serializeTier(mem: ReturnType<MemoryStore["load"]>, tier: "pinned" | "rules" | "facts"): string {
  const es = mem[tier];
  if (!es.length) return "(empty)";
  return es
    .map((e) => {
      const extra =
        e.tier === "rules"
          ? ` ·when ${e.when} ·wrong-if ${e.wrongIf}`
          : e.tier === "facts"
            ? ` ${e.provenance ? `·derived (${e.provenance})` : ""}${e.expires ? ` ·expires ${e.expires}` : ""}`
            : ` ·op ${e.on}`;
      return `- [${e.id}] ${e.text}${extra}`;
    })
    .join("\n");
}

function parseMemoryDump(store: MemoryStore): string {
  // Round-trip through parser keeps CLI honest with what retrieval will see.
  return showAll(store);
}

function showAll(store: MemoryStore): string {
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.readFileSync(store.memoryPath, "utf8").trim();
}

export { DEFAULT_MEMORY_CONFIG };
