/**
 * MEMORY.md serialization — four tiers per ARCHITECTURE §4.8.2.
 *
 * The reader is tolerant (single-line or wrapped metadata, fuzzy whitespace);
 * the writer is canonical (the template's wrapped style). Parsing never throws
 * on oddities it can skip — an operator may have edited the file by hand.
 */
import type {
  Entry,
  FactEntry,
  ParsedMemory,
  PinnedEntry,
  RuleEntry,
  StateSection,
} from "./types";

const SECTION_HEADS: Record<string, "pinned" | "rules" | "facts"> = {
  "## pinned": "pinned",
  "## rules": "rules",
  "## facts": "facts",
};

const ENTRY_LINE = /^\s*-\s*\[(?<prefix>[prf])(?<num>\d+)\]\s*(?<rest>.+)$/;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type MetaCarrier = Partial<
  Pick<RuleEntry, "when" | "wrongIf" | "confirmations" | "usedCount" | "lastUsedAt" | "createdAt"> &
    Pick<FactEntry, "provenance" | "expires" | "createdAt"> &
    Pick<PinnedEntry, "addedBy" | "on">
>;

export function parseMemory(raw: string): ParsedMemory {
  const out: ParsedMemory = { pinned: [], rules: [], facts: [], state: {} };
  let section: "pinned" | "rules" | "facts" | null = null;
  let inStateFence = false;
  let stateBuf: string[] = [];

  for (const line of raw.split("\n")) {
    const head = line.trim().toLowerCase();

    // --- inside the ```json fence: buffer until closing fence
    if (inStateFence) {
      if (line.trim() === "```") {
        inStateFence = false;
        try {
          out.state = JSON.parse(stateBuf.join("\n") || "{}") as StateSection;
        } catch {
          out.state = {};
        }
      } else {
        stateBuf.push(line);
      }
      continue;
    }

    // --- headings switch section; anything not mapped leaves section null
    if (head.startsWith("## ")) {
      section = SECTION_HEADS[head] ?? null; // `## state` → null, body picked up below
      continue;
    }
    if (head === "```json") {
      inStateFence = true;
      stateBuf = [];
      continue;
    }

    // --- entry bullet: `- [r7] text ·when ...` (metadata may ride inline)
    const m = ENTRY_LINE.exec(line);
    if (m?.groups && section) {
      const rest = m.groups.rest.trim();
      const id = `${m.groups.prefix}${m.groups.num}`;
      const dotAt = rest.indexOf("·");
      const text = (dotAt === -1 ? rest : rest.slice(0, dotAt)).trim();
      const meta: MetaCarrier = {};
      collectMetaInto(meta, dotAt === -1 ? "" : rest.slice(dotAt));
      pushEntry(out, section, id, text, meta);
      continue;
    }

    // --- or metadata wraps on following indented lines (canonical style)
    if (section && /^\s{2,}·/.test(line)) {
      const last =
        section === "pinned"
          ? out.pinned.at(-1)
          : section === "rules"
            ? out.rules.at(-1)
            : out.facts.at(-1);
      if (last) collectMetaInto(last as unknown as MetaCarrier, line.trim());
    }
  }
  return out;
}

function collectMetaInto(carrier: MetaCarrier, chunk: string): void {
  for (const tok of chunk.split("·").map((t) => t.trim()).filter(Boolean)) {
    if (tok.startsWith("when ")) carrier.when = tok.slice(5).trim();
    else if (tok.startsWith("wrong-if ") || tok.startsWith("wrong_if "))
      carrier.wrongIf = tok.replace(/^wrong-?if\s+/i, "").trim();
    else if (tok.startsWith("confirmed ")) {
      const n = Number.parseInt(tok.slice(10).trim().split("/")[0] ?? "0", 10);
      if (!Number.isNaN(n)) carrier.confirmations = n;
    } else if (tok.startsWith("used ")) {
      const n = Number.parseInt(tok.slice(5).trim(), 10);
      if (!Number.isNaN(n)) carrier.usedCount = n;
    } else if (tok.startsWith("last ")) carrier.lastUsedAt = tok.slice(5).trim();
    else if (tok.startsWith("op ")) {
      carrier.addedBy = "operator";
      carrier.on = tok.slice(3).trim();
    } else if (tok.startsWith("derived ")) carrier.provenance = tok.slice(8).trim();
    else if (tok.startsWith("src ")) carrier.provenance = tok.slice(4).trim();
    else if (tok.startsWith("expires ")) carrier.expires = tok.slice(8).trim();
    else if (tok.startsWith("created ")) carrier.createdAt = tok.slice(8).trim();
  }
}

function pushEntry(
  out: ParsedMemory,
  tier: "pinned" | "rules" | "facts",
  id: string,
  text: string,
  meta: MetaCarrier,
): void {
  if (tier === "pinned") {
    out.pinned.push({
      tier: "pinned",
      id,
      text,
      addedBy: meta.addedBy ?? "operator",
      on: meta.on ?? meta.createdAt ?? today(),
    });
  } else if (tier === "rules") {
    out.rules.push({
      tier: "rules",
      id,
      text,
      when: meta.when ?? "",
      wrongIf: meta.wrongIf ?? "",
      confirmations: meta.confirmations ?? 0,
      usedCount: meta.usedCount ?? 0,
      lastUsedAt: meta.lastUsedAt ?? null,
      createdAt: meta.createdAt ?? today(),
    });
  } else {
    out.facts.push({
      tier: "facts",
      id,
      text,
      when: meta.when ?? "",
      provenance: meta.provenance ?? null,
      expires: meta.expires ?? null,
      createdAt: meta.createdAt ?? today(),
    });
  }
}

// ---------------------------------------------------------------------------
// Serialization — canonical, human-diffable, stable ordering by id number.
// ---------------------------------------------------------------------------

export function serializeMemory(mem: ParsedMemory): string {
  const parts: string[] = [
    "# Memory",
    "",
    "## Pinned",
    "<!-- operator corrections. authoritative on write, never auto-edited -->",
  ];
  for (const p of sortByNum(mem.pinned))
    parts.push(`- [${p.id}] ${p.text} ·op ${p.on}`);

  parts.push("", "## Rules", "<!-- promoted from candidates. scoped, falsifiable, evidence-tracked -->");
  for (const r of sortByNum(mem.rules)) {
    parts.push(`- [${r.id}] ${r.text}`);
    parts.push(`       ·when ${r.when || "*"} ·wrong-if ${r.wrongIf}`);
    parts.push(`       ·confirmed ${r.confirmations} ·used ${r.usedCount} ·last ${r.lastUsedAt ? r.lastUsedAt.slice(0, 10) : "-"} ·created ${r.createdAt.slice(0, 10)}`);
  }

  parts.push("", "## Facts", "<!-- expire by default; provenance required when derived from untrusted content -->");
  for (const f of sortByNum(mem.facts)) {
    parts.push(`- [${f.id}] ${f.text}`);
    const bits: string[] = [];
    if (f.when) bits.push(`·when ${f.when}`);
    if (f.provenance) bits.push(`·derived (${f.provenance})`);
    if (f.expires) bits.push(`·expires ${f.expires.slice(0, 10)}`);
    bits.push(`·created ${f.createdAt.slice(0, 10)}`);
    parts.push(`       ${bits.join(" ")}`);
  }

  parts.push("", "## State", "```json", JSON.stringify(mem.state, null, 2), "```", "");
  return parts.join("\n");
}

function sortByNum<T extends { id: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => num(a.id) - num(b.id));
}

function num(id: string): number {
  return Number.parseInt(id.replace(/^[a-z]+/, ""), 10) || 0;
}

/** All entries across tiers — for id allocation and lookup. */
export function allEntries(mem: ParsedMemory): Entry[] {
  return [...mem.pinned, ...mem.rules, ...mem.facts];
}
