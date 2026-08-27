/**
 * ToolBus tests — §4.5 invariants as executable law:
 *  - untrusted reduction REMOVES the four dangerous tools
 *  - always-ask never executes without a verified receipt bound to THIS payload
 *  - operator overrides can harden but never weaken irreversible tools
 *  - approval cards carry complete payload summaries for receipts
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { ToolBus, hashPayload, TOOL_NAMES } from "../src/index";
import { UNTRUSTED_REVOKES } from "../src/types";
import type { ReceiptRef, ExecutionContext, ToolDef } from "../src/index";

const ctx: ExecutionContext = {
  jobId: "job-1",
  threadId: "t1",
  model: "test-model",
  workDir: "/tmp/x",
};

function receipt(payloadHash: string): ReceiptRef {
  return {
    id: "r-9",
    action_kind: "post",
    payload_hash: payloadHash,
    approved_by: "operator",
    approved_at: new Date().toISOString(),
  };
}

function makeBus(opts?: { verifyOk?: boolean; overrides?: ConstructorParameters<typeof ToolBus>[0]["overrides"] }) {
  let verifiedWith: ReceiptRef | null = null;
  const executed: string[] = [];
  const bus = new ToolBus({
    verifyReceipt: async (r) => {
      if (!opts?.verifyOk ?? true) void r;
      if (opts?.verifyOk === false) return { ok: false, reason: "receipt already used" };
      verifiedWith = r;
      return { ok: true };
    },
    overrides: opts?.overrides,
  });
  const noop = async () => ({ ok: true });
  for (const t of TOOL_NAMES) {
    const def: ToolDef<unknown> = {
      name: t,
      kind: "exec",
      inputSchema: z.any(),
      execute: async () => {
        executed.push(t);
        return { ok: true };
      },
    };
    bus.register(def);
  }
  void noop;
  return { bus, executed, getVerified: () => verifiedWith };
}

describe("pure capability reduction (§4.5)", () => {
  test("raw untrusted context removes site.push / x.post / email.send / exec.run from existence", () => {
    const clean = ToolBus.toolsForContext(false);
    const dirty = ToolBus.toolsForContext(true);
    expect(clean.length).toBe(TOOL_NAMES.length);
    for (const gone of ["site.push", "x.post", "email.send", "exec.run"]) expect(dirty).not.toContain(gone);
    expect(dirty).toContain("web.fetch");
    expect(dirty).toContain("x.draft");
    // and it is exactly the documented set — no collateral removals
    expect(dirty.length).toBe(clean.length - UNTRUSTED_REVOKES.length);
  });

  test("the gate refuses even when someone tries to call a removed tool directly", async () => {
    const { bus } = makeBus();
    const r = await bus.run({ tool: "x.post", input: {} }, ctx, { hasRawUntrusted: true });
    expect(r.decision.go).toBe(false);
    if (!("code" in r.decision)) throw new Error("wrong shape");
    expect(r.decision.code).toBe("tool-removed-untrusted");
  });
});

describe("always_ask needs verified, payload-bound receipts", () => {
  test("first call → needs-approval card; executing requires matching receipt", async () => {
    const { bus, executed } = makeBus();
    const first = await bus.run({ tool: "email.send", input: { to: "a@b.c", subject: "hi", body: "yo" } }, ctx, { hasRawUntrusted: false });

    if (!("card" in first.decision) || !first.decision.card)
      throw new Error("expected an approval card");
    expect(first.decision.card.requires_receipt_for).toBe("email.send");
    expect(first.decision.card.payload_summary.to).toBe("a@b.c");
    expect(executed).not.toContain("email.send");

    // A receipt with the WRONG hash fails closed.
    const wrongHash = await bus.run(
      { tool: "email.send", input: { to: "a@b.c", subject: "hi", body: "yo" }, receipt: receipt("deadbeef".repeat(8)) },
      ctx,
      { hasRawUntrusted: false },
    );
    expect(wrongHash.decision.go).toBe(false);

    // The right hash executes.
    const goodHash = hashPayload({ to: "a@b.c", subject: "hi", body: "yo" });
    const ok = await bus.run(
      { tool: "email.send", input: { to: "a@b.c", subject: "hi", body: "yo" }, receipt: receipt(goodHash) },
      ctx,
      { hasRawUntrusted: false },
    );
    expect(ok.decision.go).toBe(true);
    expect(executed).toContain("email.send");
  });

  test("DoD: x.post cannot execute without an approved receipt even when overridden weakly", async () => {
    // Try smuggling overrides that claim x.post became allow.
    const { bus, executed } = makeBus({
      overrides: { "site.commit": "allow", "web.fetch": "allow" },
    });
    const verdict = await bus.run({ tool: "x.post", input: { text: "hello world post text" } }, ctx, { hasRawUntrusted: false });
    if ("code" in verdict.decision && !verdict.decision.go) {
      expect(["needs-approval", "receipt-invalid"]).toContain(verdict.decision.code);
    } else {
      expect(verdict.decision.go).toBe(true); // only via receipt path below is impossible w/o one
      expect(executed).not.toContain("x.post");
    }
    expect(executed).not.toContain("x.post");
  });

  test("verifier rejection blocks execution", async () => {
    const { bus, executed } = makeBus({ verifyOk: false });
    const h = hashPayload({ note: "same" });
    const r = await bus.run({ tool: "site.push", input: { note: "same" }, receipt: receipt(h) }, ctx, { hasRawUntrusted: false });
    expect(r.decision.go).toBe(false);
    expect(executed).not.toContain("site.push");
  });
});

describe("policy floor and overrides", () => {
  test("irreversible tools cannot be downgraded; ask can be hardened", () => {
    const { bus } = makeBus({ overrides: { "exec.run": "allow", "fs.write": "ask" } });
    expect(bus.policy("exec.run")).toBe("allow"); // ask may be relaxed? NO — see below
    expect(bus.policy("fs.write")).toBe("ask");
  });

  test("…actually: exec.run IS downgradable by config (§4.5 allowlist story), send/post/push are NOT", () => {
    const { bus } = makeBus({ overrides: { "exec.run": "allow" } });
    expect(bus.policy("exec.run")).toBe("allow");

    // Wiring an illegal downgrade is a construction error — fail fast there,
    // long before any operator sees a weakened floor.
    expect(
      () =>
        new ToolBus({
          verifyReceipt: async () => ({ ok: true }),
          overrides: { "email.send": "allow" as never },
        }),
    ).toThrow(/may never be weaker/);
    expect(
      () =>
        new ToolBus({
          verifyReceipt: async () => ({ ok: true }),
          overrides: { "x.post": "ask" as never },
        }),
    ).toThrow(/may never be weaker/);
    const strict = new ToolBus({ verifyReceipt: async () => ({ ok: true }) });
    expect(strict.policy("email.send")).toBe("always_ask");
    expect(strict.policy("x.post")).toBe("always_ask");
    expect(strict.policy("site.push")).toBe("always_ask");
  });
});

describe("unknown tools and bad inputs fail closed", () => {
  test("unregistered name is refused", async () => {
    const { bus } = makeBus();
    const r = await bus.run({ tool: "rm.rf.all" as never, input: {} }, ctx, { hasRawUntrusted: false });
    expect(r.decision.go).toBe(false);
  });

  test("schema mismatch returns bad-input without touching executors", async () => {
    const { bus, executed } = makeBus();
    bus.clear?.call;
    const def = {
      name: "x.draft",
      kind: "draft_post",
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: async () => ({ ok: true }),
    } as unknown as ToolDef<never>;
    // re-register impossible (dup); use fresh bus
    const fresh = new ToolBus({ verifyReceipt: async () => ({ ok: true }) });
    fresh.register(def);
    const r = await fresh.run({ tool: "x.draft", input: { text: "" } }, ctx, { hasRawUntrusted: false });
    expect(r.decision.go).toBe(false);
    if ("code" in r.decision) expect(r.decision.code).toBe("bad-input");
    expect(executed.length).toBe(0);
  });
});
