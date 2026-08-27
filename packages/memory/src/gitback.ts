/**
 * Git-backing (§4.8.9): `memory.git: true` makes the threads directory a git
 * repository and commits after each write (`thread/<slug>: memory after job…`),
 * giving history, blame, diff and revert for free.
 *
 * Failures never break the write path: if git is missing or unhappy we return
 * false and let the caller log; memory itself is file-backed first.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export class GitBacking {
  constructor(
    private readonly threadsDir: string,
    private readonly enabled: boolean,
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Idempotently ensure the threads dir is a repo with an initial commit. */
  async init(): Promise<boolean> {
    if (!this.enabled) return true;
    try {
      const { $ } = await import("bun");
      if (!existsSync(join(this.threadsDir, ".git"))) {
        await $`git -C ${this.threadsDir} init -q`.quiet();
        await $`git -C ${this.threadsDir} add -A`.quiet();
        await $`git -C ${this.threadsDir} -c user.name=hivekit -c user.email=hivekit@local commit -qm "threads: initial"`.quiet();
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Commit all changes under one thread's directory. Returns commit hash or
   * null (nothing to commit / disabled / error).
   */
  async commitThread(slug: string, messageSuffix: string): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      const { $ } = await import("bun");
      const threadPath = slug;
      await $`git -C ${this.threadsDir} add ${threadPath}`.quiet();
      const status = await $`git -C ${this.threadsDir} status --porcelain -- ${threadPath}`.text();
      if (!status.trim()) return null;
      const out = await $`git -C ${this.threadsDir} -c user.name=hivekit -c user.email=hivekit@local commit -qm ${`thread/${slug}: ${messageSuffix}`} && git -C ${this.threadsDir} rev-parse HEAD`.text();
      return out.trim();
    } catch {
      return null;
    }
  }

  async log(slug: string, limit = 20): Promise<Array<{ hash: string; at: string; message: string }>> {
    if (!this.enabled || !existsSync(join(this.threadsDir, slug))) return [];
    try {
      const { $ } = await import("bun");
      const raw = await $`git -C ${this.threadsDir} log --format=%H%x1f%aI%x1f%s -n ${limit} -- ${slug}`.text();
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash = "", at = "", message = ""] = line.split("\x1f");
          return { hash, at, message };
        });
    } catch {
      return [];
    }
  }

  async diff(slug: string, fromHash?: string): Promise<string> {
    if (!this.enabled) return "";
    try {
      const { $ } = await import("bun");
      const path = slug;
      if (fromHash) {
        return await $`git -C ${this.threadsDir} diff ${fromHash} HEAD -- ${path}`.text();
      }
      return await $`git -C ${this.threadsDir} diff HEAD~1 HEAD -- ${path}`.text().catch(() => "");
    } catch {
      return "";
    }
  }

  /**
   * Revert the previous MEMORY.md change to <slug> — DoD: restores the
   * previous memory and the NEXT job uses it (i.e., affects the live file).
   */
  async revert(slug: string): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      const { $ } = await import("bun");
      const path = slug;
      const commits = await $`git -C ${this.threadsDir} log --format=%H -n 2 -- ${path}`.text();
      const [head, prev] = commits.split("\n").filter(Boolean);
      if (!head || !prev) return null;
      await $`git -C ${this.threadsDir} checkout ${prev} -- ${path}`.quiet();
      const hash = await $`git -C ${this.threadsDir} -c user.name=hivekit -c user.email=hivekit@local commit -qm ${`thread/${slug}: revert memory to ${prev.slice(0, 8)}`} && git -C ${this.threadsDir} rev-parse HEAD`.text();
      return hash.trim();
    } catch {
      return null;
    }
  }
}
