/**
 * Filesystem primitives: atomic replace and JSONL append.
 *
 * Atomic replace = temp file → fsync → rename. A crash at ANY point leaves
 * either the previous file intact or the new one complete — never half
 * (todo/02 DoD: "a SIGKILL during a memory write leaves the previous
 * MEMORY.md intact and parseable").
 *
 * `crashBeforeRename` is an exported TEST SEAM: set by durability tests to
 * simulate dying between fsync and rename without needing an actual kill
 * signal inside a synchronous path. Production code never touches it.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CRASH_BEFORE_RENAME: { on: boolean } = { on: false };

let ATOMIC_SEQ = 0;

export function atomicWrite(path: string, contents: string): void {
  const dir = join(path, "..");
  // Temp name must be unique even for many writes in the same millisecond.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${ATOMIC_SEQ++}`;
  try {
    writeFileSync(tmp, contents);
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (CRASH_BEFORE_RENAME.on) {
      // Simulated death after fsync, before rename: leaves the previous file
      // intact plus a stray .tmp-* exactly as a real SIGKILL would. A crashed
      // process cannot clean its own temp file, so we deliberately do not.
      CRASH_BEFORE_RENAME.on = false;
      const err = new Error("simulated crash between fsync and rename");
      err.name = "CrashInjected";
      throw err;
    }
    renameSync(tmp, path);
  } catch (err) {
    // A real crash has no cleanup; neither does its simulation.
    if ((err as Error).name === "CrashInjected") throw err;
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
}

/** Remove stale temp files left by an interrupted write; called on open(). */
export function sweepTempFiles(dir: string, base: string): number {
  let removed = 0;
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    for (const f of readdirSync(dir)) {
      if (f.startsWith(`${base}.tmp-`)) {
        unlinkSync(join(dir, f));
        removed++;
      }
    }
  } catch {
    /* directory may not exist yet */
  }
  return removed;
}

export function appendJsonl<T>(path: string, row: T): void {
  // Append to existing content atomically enough for JSONL: single write call.
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, prev.endsWith("\n") || prev === "" ? `${prev}${JSON.stringify(row)}\n` : `${prev}\n${JSON.stringify(row)}\n`);
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}
