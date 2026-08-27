/**
 * Redaction at the serialisation boundary (todo/01 DoD).
 *
 * The writer holds the active secret set — redaction is applied by whoever
 * serialises outbound text (logs, WS frames, error reports), NOT as a regex
 * over finished strings after the fact. Secrets registered here are matched
 * literally and replaced with their shape-preserving mask.
 */
const MASK = "[REDACTED]";

export class Redactor {
  #secrets: Set<string> = new Set();
  /** Sorted longest-first so overlapping secrets mask fully. */
  #sorted: string[] = [];

  register(secret: string): void {
    if (!secret || secret.length < 6) return; // too short to be worth masking reliably
    this.#secrets.add(secret);
    this.#sorted = [...this.#secrets].sort((a, b) => b.length - a.length);
  }

  registerMany(secrets: Iterable<string>): void {
    for (const s of secrets) this.register(s);
  }

  get size(): number {
    return this.#secrets.size;
  }

  apply(text: string): string {
    let out = text;
    for (const s of this.#sorted) {
      if (out.includes(s)) out = out.split(s).join(MASK);
    }
    return out;
  }

  applyToError(err: unknown): string {
    const msg =
      err instanceof Error ? `${err.name}: ${err.message}\n${String(err.stack ?? "")}` : String(err);
    return this.apply(msg);
  }
}