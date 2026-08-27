/**
 * Tolerant JSON extraction + repair (4.4.1).
 * Accepts the block anywhere in the reply; repairs the usual damage; every
 * repair is counted against the model. Parsing never throws.
 */

export type RepairKind =
  | "prose-around"
  | "fence-stripped"
  | "trailing-comma"
  | "single-quotes"
  | "unquoted-keys"
  | "smart-quotes"
  | "concatenated-json";

export type RepairCounts = Partial<Record<RepairKind, number>>;

export class RepairCounter {
  readonly counts: RepairCounts = {};
  count(kind: RepairKind): void {
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
  }
  total(): number {
    return Object.values(this.counts).reduce((a, b) => a + (b ?? 0), 0);
  }
}

const SMART_OPEN = /[\u201c\u2018\u00ab\u2039]/g;
const SMART_CLOSE = /[\u201d\u2019\u00bb\u203a]/g;
const SMART_APOSTROPHE = /\u2019/g;

function looksLikeJsonStart(s: string): boolean {
  return /^[{[]/.test(s.trim());
}

function findJsonStart(s: string): number {
  for (let i = 0; i < s.length; i++) if (s[i] === "{" || s[i] === "[") return i;
  return -1;
}

/**
 * Pull the FIRST balanced JSON value out of free text, honoring strings and
 * escapes during the balance scan. Never throws.
 */
export function extractJsonBlock(
  text: string,
): { raw: string; hadProse: boolean; hadFence: boolean } {
  let candidate = text.trim();
  let hadProse = false;
  let hadFence = false;

  const fence = /```(?:json|[a-z]*)?\s*\n?([\s\S]*?)(?:\n?```|$)/i.exec(candidate);
  const inner = (fence?.[1] ?? "").trim();
  if (inner && looksLikeJsonStart(inner)) {
    candidate = inner;
    hadFence = true;
  }

  const start = findJsonStart(candidate);
  if (start < 0) return { raw: candidate, hadProse: false, hadFence };
  if (start > 0) hadProse = true;

  const openChar = candidate[start] as "{" | "[";
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        const rest = candidate.slice(i + 1).trim();
        return {
          raw: candidate.slice(start, i + 1),
          hadProse: start > 0 || rest.length > 0,
          hadFence,
        };
      }
    }
  }
  return { raw: candidate.slice(start), hadProse: start > 0, hadFence };
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Split TEXT into top-level JSON sibling values ("{a}{b}" → two slices).
 * Returns null unless ≥2 siblings exist. String-aware; nested braces safe.
 */
export function topLevelSiblings(text: string): string[] | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  const starts: number[] = [];
  let curStart = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") {
      if (depth === 0) curStart = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && curStart >= 0) {
        starts.push(curStart);
        curStart = -1;
      }
      if (depth < 0) return null;
    }
  }
  if (starts.length < 2 || depth !== 0) return null;
  // Slice each sibling until just before the next start / end.
  const bounds = [...starts.slice(1), text.replace(/\s+$/, "").length];
  const out = starts.map((s0, k) => text.slice(s0, bounds[k]!).trimEnd());
  void esc;
  return out.every((x) => /^[{[]/.test(x)) ? out : null;
}

/**
 * Parse a possibly-damaged JSON payload. On success returns the parsed value
 * plus every repair applied; on failure returns the precise parse error.
 */
export function parseTolerant(
  input: string,
  counter?: RepairCounter,
): { ok: true; value: unknown } | { ok: false; error: string } {
  // Sibling detection MUST precede extractJsonBlock: that scanner stops at
  // the first balanced value and would otherwise amputate everything after
  // the seam ("{a:1}{b:2}" → raw becomes just {"a":1}).
  {
    const sibs = topLevelSiblings(input.trim());
    if (sibs) {
      counter?.count("concatenated-json");
      const preCat = tryParse(`[${sibs.join(",")}]`);
      if (preCat.ok) return preCat;
    }
  }

  const { raw, hadProse, hadFence } = extractJsonBlock(input);
  let s = raw;

  if (hadFence) counter?.count("fence-stripped");

  if (/[\u201c\u201d\u2018\u2019\u00ab\u00bb]/.test(s)) {
    s = s.replace(SMART_OPEN, '"').replace(SMART_CLOSE, '"').replace(SMART_APOSTROPHE, "'");
    counter?.count("smart-quotes");
  }

  const first = tryParse(s);
  if (first.ok) {
    if (hadProse) counter?.count("prose-around");
    return first;
  }

  // Trailing commas before } ] or after the final member.
  const noTrailing = s.replace(/,\s*([}\]])/g, "$1");
  if (noTrailing !== s) counter?.count("trailing-comma");
  const step1 = tryParse(noTrailing);
  if (step1.ok) {
    if (hadProse) counter?.count("prose-around");
    return step1;
  }

  // Single-quoted strings -> double-quoted.
  const dq = swapSingleQuotes(noTrailing);
  if (dq !== noTrailing) counter?.count("single-quotes");
  const step2 = tryParse(dq);
  if (step2.ok) {
    if (hadProse) counter?.count("prose-around");
    return step2;
  }

  // Unquoted keys -> quoted.
  const qk = quoteKeys(dq);
  if (qk !== dq) counter?.count("unquoted-keys");
  const step3 = tryParse(qk);
  if (step3.ok) {
    if (hadProse) counter?.count("prose-around");
    return step3;
  }

  // Concatenated objects -> array ({...}{...} from chatty models).
  const cat = joinConcatenated(qk);
  if (cat) {
    counter?.count("concatenated-json");
    const step4 = tryParse(cat);
    if (step4.ok) return step4;
  }

  return { ok: false, error: first.error };
}

function swapSingleQuotes(s: string): string {
  if (!/'/.test(s)) return s;
  let out = "";
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inDouble) {
      out += ch;
      if (ch === "\\") { out += s[++i] ?? ""; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "\\") { out += "\\" + (s[++i] ?? ""); continue; }
      if (ch === "'") { out += '"'; inSingle = false; continue; }
      out += ch === '"' ? '\\"' : ch;
      continue;
    }
    if (ch === '"') { inDouble = true; out += ch; continue; }
    if (ch === "'") { inSingle = true; out += '"'; continue; }
    out += ch;
  }
  return out;
}

function quoteKeys(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") { out += s[++i] ?? ""; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(s.slice(i));
    // Preceding structural char may be followed by whitespace (pretty-printed
    // JSON puts the newline between `{` and the key).
    const prev = out.replace(/\s+$/, "").at(-1);
    if (m && (prev === "{" || prev === ",")) {
      out += `"${m[1]}":`;
      i += m[0].length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function joinConcatenated(s: string): string | null {
  if (!/\}\s*\{/.test(s)) return null;
  const parts = s.split(/\}\s*\{/).filter(Boolean);
  if (parts.length < 2) return null;
  const joined = parts.map((p) => (p.startsWith("{") ? p : "{" + p)).join(",");
  const arr = "[" + joined + "]";
  return looksLikeJsonStart(arr) ? arr : null;
}

/** Human rendering for retry prompts - the exact-error contract (FR-A6). */
export function describeRepairs(c: RepairCounts): string {
  const kinds = Object.entries(c).filter(([, n]) => (n ?? 0) > 0);
  if (!kinds.length) return "none";
  return kinds.map(([k, n]) => `${k}×${n}`).join(", ");
}