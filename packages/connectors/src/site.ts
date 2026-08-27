/**
 * Site connector — git-backed publishing (FR-K2, §4.5).
 *
 * `site.commit` is allow-tier: branch per job under a persistent clone,
 * write files via the tool (paths jailed to repo root), commit.
 * `site.push` is always-ask: the CALL produces a diff preview for the card;
 * real pushing happens ONLY when the operator's approved receipt re-runs it.
 *
 * All git access shells out to system git — matching deploy images that
 * already install git+openssh for this exact purpose. No shell string
 * interpolation anywhere: every invocation passes fixed argv arrays.
 */
import { z } from "zod";
import { join } from "node:path";
import type { ToolDef } from "@hivekit/tools";

export interface SiteConfig {
  /** Local cache directory holding the one clone (gateway-owned). */
  cloneDir: string;
  branch: string;
  remote?: string; // default "origin"
  env?: Record<string, string>; // GIT_SSH_COMMAND etc.
}

export class SiteRepo {
  constructor(private readonly cfg: SiteConfig) {}

  private async git(args: readonly string[], cwd: string): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...this.cfg.env },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim().slice(0, 300)}`);
    return out;
  }

  async ensureClone(): Promise<void> {
    try {
      await this.git(["rev-parse", "--is-inside-work-tree"], this.cfg.cloneDir);
    } catch {
      throw new Error(`no clone at ${this.cfg.cloneDir} — gateway must run 'clone once' at thread setup`);
    }
  }

  head(): Promise<string> {
    return this.git(["rev-parse", "HEAD"], this.cfg.cloneDir);
  }

  branchFor(jobId: string): string {
    // Job branches sort by time and stay greppable.
    return `hk/${jobId.slice(0, 8)}`;
  }

  async startJobBranch(jobId: string): Promise<string> {
    await this.ensureClone();
    const base = this.cfg.branch ?? "main";
    const clean = await this.git(["status", "--porcelain"], this.cfg.cloneDir);
    if (clean.trim()) throw new Error("worktree dirty — refusing to branch");
    await this.git(["fetch", "--quiet", this.cfg.remote ?? "origin", base], this.cfg.cloneDir).catch(() => {});
    const branch = this.branchFor(jobId);
    await this.git(["checkout", "-B", branch, `refs/remotes/${this.cfg.remote ?? "origin"}/${base}`], this.cfg.cloneDir)
      .catch(async () => this.git(["checkout", "-B", branch, base], this.cfg.cloneDir));
    return branch;
  }

  async commitAll(message: string): Promise<string> {
    await this.git(["add", "-A"], this.cfg.cloneDir);
    await this.git(
      ["-c", "user.name=hivekit-site", "-c", "user.email=hivekit@local", "commit", "-m", message],
      this.cfg.cloneDir,
    );
    return this.head();
  }

  /** Diff preview for the approval card vs the config branch tip. */
  async diffAgainstBase(): Promise<string> {
    const base = this.cfg.branch ?? "main";
    try {
      return await this.git(["diff", `${this.cfg.remote ?? "origin"}/${base}...HEAD`, "--stat", "--unified=1"], this.cfg.cloneDir);
    } catch {
      return this.git(["diff", "HEAD~1", "--stat", "--unified=1"], this.cfg.cloneDir);
    }
  }

  /**
   * THE push. Only ever invoked through the bus after receipt verification —
   * and even then exactly as hard-coded argv against the configured remote.
   */
  async pushCurrent(branch: string): Promise<string> {
    return this.git(
      ["push", this.cfg.remote ?? "origin", `${branch}:${this.cfg.branch}`, "--atomic"],
      this.cfg.cloneDir,
    );
  }

  filePath(rel: string): string {
    const p = join(this.cfg.cloneDir, rel);
    if (!p.startsWith(this.cfg.cloneDir)) throw new Error(`path escapes repo: ${rel}`);
    return p;
  }
}

export function makeSiteTools(repo: SiteRepo): Array<ToolDef<unknown>> {
  const WriteInput = z.object({
    path: z.string().min(1),
    content: z.string(),
  });
  const CommitInput = z.object({ message: z.string().min(3).max(200) });
  const PushInput = z.object({ note: z.string().max(500).optional() });

  return [
    {
      name: "fs.write",
      kind: "fs",
      inputSchema: WriteInput as unknown as import("zod").ZodType<unknown>,
      describe(input) {
        const i = input as { path: string; content: string };
        return { title: `write ${i.path}`, payload_summary: { path: i.path, bytes: String(i.content.length) } };
      },
      execute: async (input) => {
        const i = input as { path: string; content: string };
        await Bun.write(repo.filePath(i.path), i.content);
        return { ok: true, structured: { wrote: i.path, bytes: i.content.length } };
      },
    },
    {
      name: "site.commit",
      kind: "commit",
      inputSchema: CommitInput as unknown as import("zod").ZodType<unknown>,
      describe(input) {
        const i = input as { message: string };
        return { title: `commit: ${i.message}`, payload_summary: { message: i.message } };
      },
      execute: async (input) => {
        const i = input as { message: string };
        const hash = await repo.commitAll(i.message);
        const diff = await repo.diffAgainstBase();
        return { ok: true, structured: { hash, diff_preview: diff } };
      },
    },
    {
      name: "site.push",
      kind: "push",
      inputSchema: PushInput as unknown as import("zod").ZodType<unknown>,
      describe(_input) {
        return {
          title: "push site changes",
          payload_summary: { action: "git push to operator branch" },
        };
      },
      execute: async (_input, ctx) => {
        const branch = repo.branchFor(ctx.jobId);
        try {
          await repo.pushCurrent(branch);
          return { ok: true, structured: { pushed: true, branch } };
        } catch (err) {
          return { ok: false, error: (err as Error).message.slice(0, 300), structured: { pushed: false } };
        }
      },
    },
  ];
}
