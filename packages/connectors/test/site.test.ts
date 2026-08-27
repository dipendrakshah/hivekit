/**
 * Site connector tests with REAL git — a bare "remote" plus a clone in tmp,
 * no network. Proves: branch-per-job, commit, diff preview, and that push
 * only happens when invoked through the bus WITH an approved receipt.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SiteRepo, makeSiteTools } from "../src/site";
import { ToolBus, hashPayload } from "@hivekit/tools";

let root: string;
const sh = async (args: string[], cwd?: string) => {
  const p = Bun.spawn(args, { cwd });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}`);
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "hksite-"));
  // bare remote + seeded content
  await sh(["git", "init", "--bare", "-q", join(root, "remote.git")]);
  await sh(["git", "clone", "-q", join(root, "remote.git"), join(root, "seed")]);
  await Bun.write(join(root, "seed", "index.html"), "<h1>hello</h1>\n");
  await sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], join(root, "seed"));
  await sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], join(root, "seed"));
  await sh(["git", "push", "-q", "origin", "main"], join(root, "seed"));
  await sh(["git", "clone", "-q", join(root, "remote.git"), join(root, "clone")]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function wired(jobId = "job-abcdef12") {
  const repo = new SiteRepo({ cloneDir: join(root, "clone"), branch: "main" });
  let receiptsUsed: unknown[] = [];
  const bus = new ToolBus({
    verifyReceipt: async (r) => {
      receiptsUsed.push(r);
      return { ok: true };
    },
  });
  for (const t of makeSiteTools(repo)) bus.register(t as never);
  const ctx = { jobId, threadId: "th", workDir: root };
  void receiptsUsed;
  return { repo, bus, ctx, jobId };
}

describe("site connector", () => {
  test("allow-tier write+commit works without approval; push returns a card first", async () => {
    const w = wired();
    await w.repo.startJobBranch(w.jobId);
    const wr = await w.bus.run({ tool: "fs.write", input: { path: "blog/post.md", content: "# hi" } }, w.ctx, { hasRawUntrusted: false });
    expect(wr.decision.go).toBe(true);
    const cm = await w.bus.run({ tool: "site.commit", input: { message: "add post" } }, w.ctx, { hasRawUntrusted: false });
    expect(cm.decision.go).toBe(true);
    expect(cm.result?.structured.diff_preview).toContain("post.md");

    const push = await w.bus.run({ tool: "site.push", input: {} }, w.ctx, { hasRawUntrusted: false });
    if ("card" in push.decision && push.decision.card) {
      expect(push.decision.card.title).toMatch(/push/i);
      expect(push.decision.card.requires_receipt_for).toBe("site.push");
    } else throw new Error("site.push must produce a card on first call");
  });

  test("DoD: with approved receipt the push REALLY lands on the remote main", async () => {
    const w = wired();
    await w.repo.startJobBranch(w.jobId);
    await Bun.write(join(root, "clone", "index.html"), "<h1>CHANGED</h1>\n");
    await w.bus.run({ tool: "site.commit", input: { message: "change hero" } }, w.ctx, { hasRawUntrusted: false });

    const payloadHash = hashPayload({});
    const r = await w.bus.run(
      {
        tool: "site.push",
        input: {},
        receipt: {
          id: "rec-1",
          action_kind: "push",
          payload_hash: payloadHash,
          approved_by: "operator",
          approved_at: new Date().toISOString(),
        },
      },
      w.ctx,
      { hasRawUntrusted: false },
    );
    expect(r.decision.go).toBe(true);

    // Verify on the SEED clone which tracks remote main.
    await sh(["git", "-C", join(root, "seed"), "pull", "-q"]);
    const head = Bun.file(join(root, "seed", "index.html"));
    expect(await head.text()).toContain("CHANGED");
  });

  test("deny path: no receipt → no execution; site.commit remains allow-tier", async () => {
    const w = wired();
    await w.repo.startJobBranch(w.jobId);
    const first = await w.bus.run({ tool: "site.push", input: {} }, w.ctx, { hasRawUntrusted: false });
    expect(first.result).toBeUndefined();

    // But allow-tier commits still flow during the same job.
    await Bun.write(join(root, "clone", "notes.md"), "draft");
    const c = await w.bus.run({ tool: "site.commit", input: { message: "draft notes" } }, w.ctx, { hasRawUntrusted: false });
    expect(c.decision.go).toBe(true);
  });
});
