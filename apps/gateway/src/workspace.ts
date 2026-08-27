/**
 * Thread workspace — each thread is a directory on the data volume (§4.8):
 *
 *   /data/threads/<slug>/
 *     INSTRUCTIONS.md      operator-written (seeded empty in stream 01)
 *     MEMORY.md            seeded with the four-tier skeleton
 *     memory/              sidecars (created here, filled by stream 02)
 *     artifacts/
 *     jobs/<job-id>/
 *
 * Files are the source of truth; SQLite stores the path + content hash so an
 * out-of-band edit can be detected and reloaded. Slugs are strict: lowercase,
 * digits, dashes — they become path components.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const MEMORY_SKELETON = `# Memory

## Pinned
<!-- operator corrections. authoritative on write, never auto-edited -->

## Rules
<!-- promoted from candidates. scoped, falsifiable, evidence-tracked -->

## Facts
<!-- expire by default; provenance required when derived from untrusted content -->

## State
\`\`\`json
{}
\`\`\`
`;

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "thread";
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Atomic replace: temp file → fsync → rename. Never a half-written file. */
export function atomicWrite(path: string, contents: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents);
  const fd = Bun.file(tmp);
  // bun exposes no fsync on File; use node's fs for durability.
  const { openSync, fsyncSync, closeSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
  try {
    const f = openSync(tmp, "r+");
    fsyncSync(f);
    closeSync(f);
  } catch {
    unlinkSync(tmp);
    throw new Error(`workspace: fsync failed for ${path}`);
  }
  renameSync(tmp, path);
  void fd;
}

export class ThreadWorkspace {
  readonly root: string;

  constructor(
    dataDir: string,
    readonly slug: string,
  ) {
    this.root = join(dataDir, "threads", slug);
  }

  ensure(): void {
    mkdirSync(join(this.root, "memory"), { recursive: true });
    mkdirSync(join(this.root, "artifacts"), { recursive: true });
    mkdirSync(join(this.root, "jobs"), { recursive: true });
    const instr = join(this.root, "INSTRUCTIONS.md");
    if (!existsSync(instr)) writeFileSync(instr, "# Instructions\n\n");
    const mem = join(this.root, "MEMORY.md");
    if (!existsSync(mem)) writeFileSync(mem, MEMORY_SKELETON);
  }

  instructionsPath(): string {
    return join(this.root, "INSTRUCTIONS.md");
  }

  memoryPath(): string {
    return join(this.root, "MEMORY.md");
  }

  instructionsHash(): string {
    return sha256File(this.instructionsPath());
  }

  memoryHash(): string {
    return sha256File(this.memoryPath());
  }

  readInstructions(): string {
    return readFileSync(this.instructionsPath(), "utf8");
  }

  jobDir(jobId: string): string {
    const dir = join(this.root, "jobs", jobId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}