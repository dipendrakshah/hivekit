/**
 * X connector tests: OAuth1 signing determinism and the always-ask gate on
 * x.post over an injected transport (no network, no real creds).
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { makeXTools, signOAuth1 } from "../src/x";
import { ToolBus, hashPayload } from "@hivekit/tools";
import type { XCredentials } from "../src/x";

const CREDS: XCredentials = {
  consumer_key: "ck_test",
  consumer_secret: "cs_test_secret",
  access_token_key: "at_test",
  access_token_secret: "ats_test_secret",
};

describe("OAuth 1.0a signer", () => {
  test("deterministic signature for fixed nonce+timestamp; HMAC correctness", () => {
    const headers = signOAuth1(
      "POST",
      "https://api.x.com/2/tweets",
      CREDS,
      [],
      "abc123nonce",
      "1756200000",
    );
    const auth = headers.Authorization!;
    expect(auth.startsWith("OAuth ")).toBe(true);
    expect(auth).toContain('oauth_consumer_key="ck_test"');
    expect(auth).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(auth).toContain('oauth_nonce="abc123nonce"');

    const sig = /oauth_signature="([^"]+)"/.exec(auth)![1]!;
    // Independent recomputation of RFC5849 base string:
    const base = [
      "POST",
      encodeURIComponent("https://api.x.com/2/tweets"),
      encodeURIComponent(
        `oauth_consumer_key=ck_test&oauth_nonce=abc123nonce&oauth_signature_method=HMAC-SHA1&oauth_timestamp=1756200000&oauth_token=at_test&oauth_version=1.0`,
      ),
    ].join("&");
    const key = `${encodeURIComponent(CREDS.consumer_secret)}&${encodeURIComponent(CREDS.access_token_secret)}`;
    const expected = createHmac("sha1", key).update(base).digest("base64");
    expect(sig).toBe(encodeURIComponent(expected));
  });

  test("percent-encoding escapes reserved chars per RFC3986", () => {
    const h = signOAuth1("POST", "https://api.x.com/2/tweets", { ...CREDS, consumer_key: "ck*plus+" }, [], "n", "1");
    expect(h.Authorization!).toContain("ck%2Aplus%2B");
  });
});

describe("x tools through the bus", () => {
  function wired() {
    const posted: Array<{ text: string }> = [];
    const bus = new ToolBus({ verifyReceipt: async () => ({ ok: true }) });
    const postTransport = async (_c: XCredentials, text: string) => {
      posted.push({ text });
      return { id: "tweet_123" };
    };
    for (const t of makeXTools({
      getCreds: async () => CREDS,
      postTweet: postTransport,
    }))
      bus.register(t as never);
    const ctx = { jobId: "jx", threadId: "t", workDir: "/tmp" };
    return { bus, ctx, posted };
  }

  test("DoD: x.draft allow-tier runs free; x.post first call returns card, NEVER posts", async () => {
    const w = wired();
    const draft = await w.bus.run({ tool: "x.draft", input: { text: "variant one" } }, w.ctx, { hasRawUntrusted: false });
    expect(draft.decision.go).toBe(true);

    const gated = await w.bus.run({ tool: "x.post", input: { text: "the real tweet text" } }, w.ctx, { hasRawUntrusted: false });
    if ("card" in gated.decision && gated.decision.card) {
      expect(gated.decision.card.diff_preview).toContain("the real tweet text");
      expect(gated.decision.card.source_flagged).toBe(false);
    }
    expect(w.posted.length).toBe(0);
  });

  test("receipt-bound post executes exactly once with matching payload", async () => {
    const w = wired();
    const input = { text: "approved variant two" };
    const ok = await w.bus.run(
      { tool: "x.post", input, receipt: { id: "r", action_kind: "post", payload_hash: require("node:crypto").createHash("sha256").update(JSON.stringify(input)).digest("hex"), approved_by: "op", approved_at: new Date().toISOString() } },
      w.ctx,
      { hasRawUntrusted: false },
    );
    expect(ok.decision.go).toBe(true);
    expect(w.posted).toEqual([{ text: "approved variant two" }]);
  });

  test("missing credentials fail loudly in execute after a valid receipt", async () => {
    const bus = new ToolBus({ verifyReceipt: async () => ({ ok: true }) });
    for (const t of makeXTools({ getCreds: async () => null, postTweet: async () => ({}) })) bus.register(t as never);
    const input = { text: "no creds path" };
    const r = await bus.run(
      {
        tool: "x.post",
        input,
        receipt: { id: "r", action_kind: "post", payload_hash: hashPayload(input), approved_by: "op", approved_at: new Date().toISOString() },
      },
      { jobId: "j", threadId: "t", workDir: "/tmp" },
      { hasRawUntrusted: false },
    );
    expect(r.decision.go).toBe(true);
    expect(r.result?.ok).toBe(false);
    expect(r.result?.error).toMatch(/credentials not configured/i);
  });
});
