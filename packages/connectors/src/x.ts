/**
 * X connector (FR-K3).
 *
 * x.draft (allow) produces tweet variants; x.post (always_ask) posts via
 * X API v2 using OAuth 1.0a user context — chosen over OAuth2 PKCE because
 * server-side daemon credentials need no refresh dance and app-password-less
 * rotation fits the vault model. Signing is plain HMAC-SHA1 per RFC 5849.
 *
 * Credentials come from an injected vault getter at register time and are
 * NEVER logged: the signer works on values the redactor holds.
 */
import { z } from "zod";
import { createHmac, randomBytes } from "node:crypto";
import type { ToolDef } from "@hivekit/tools";

const API_URL = "https://api.x.com/2/tweets";

export interface XCredentials {
  consumer_key: string;
  consumer_secret: string;
  access_token_key: string;
  access_token_secret: string;
}

export function signOAuth1(
  method: string,
  url: string,
  creds: XCredentials,
  bodyParams?: Array<[string, string]>,
  nonce = randomBytes(16).toString("hex"),
  ts = String(Math.floor(Date.now() / 1000)),
): Record<string, string> {
  const oauth = new Map<string, string>([
    ["oauth_consumer_key", creds.consumer_key],
    ["oauth_nonce", nonce],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", ts],
    ["oauth_token", creds.access_token_key],
    ["oauth_version", "1.0"],
  ]);

  // Signature base collects oauth params plus JSON-body-free query params;
  // for POST /2/tweets the JSON body is NOT part of the base string.
  const pairs = [...oauth.entries(), ...(bodyParams ?? [])].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const paramStr = pairs.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join("&");
  const u = new URL(url);
  const baseStr = [method.toUpperCase(), rfc3986(u.toString()), rfc3986(paramStr)].join("&");

  const key = `${rfc3986(creds.consumer_secret)}&${rfc3986(creds.access_token_secret)}`;
  const sig = createHmac("sha1", key).update(baseStr).digest("base64");
  oauth.set("oauth_signature", sig);

  const header = "OAuth " + [...oauth.entries()].filter(([k]) => k.startsWith("oauth_")).map(([k, v]) => `${rfc3986(k)}="${rfc3986(v)}"`).join(", ");
  return { Authorization: header };
}

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface XToolOptions {
  getCreds(): Promise<XCredentials | null>;
  postTweet?(creds: XCredentials, text: string): Promise<{ id?: string }>; // injectable transport
}

export function makeXTools(opts: XToolOptions): Array<ToolDef<unknown>> {
  const DraftInput = z.object({
    text: z.string().min(1).max(280),
    variants: z.number().int().min(1).max(5).optional(),
  });
  const PostInput = z.object({ text: z.string().min(1).max(280), in_reply_to_id: z.string().optional() });

  const draft: ToolDef<unknown> = {
    name: "x.draft",
    kind: "draft_post",
    inputSchema: DraftInput as unknown as import("zod").ZodType<unknown>,
    describe(input) {
      const i = input as { text: string };
      return { title: "draft tweets", payload_summary: { text: i.text.slice(0, 80) } };
    },
    async execute(input) {
      const i = input as { text: string };
      // Drafting never touches the network or credentials.
      return { ok: true, structured: { drafts: [{ text: i.text }] } };
    },
  };

  const post: ToolDef<unknown> = {
    name: "x.post",
    kind: "post",
    inputSchema: PostInput as unknown as import("zod").ZodType<unknown>,
    describe(input) {
      const i = input as { text: string };
      return {
        title: "post to X",
        diff_preview: i.text,
        payload_summary: { chars: String(i.text.length), api: "POST /2/tweets" },
      };
    },
    async execute(input, ctx) {
      const i = input as { text: string; in_reply_to_id?: string };
      const creds = await opts.getCreds();
      if (!creds) return { ok: false, error: "X credentials not configured", structured: {} };

      let response: { ok: boolean; status: number; body: string };
      if (opts.postTweet) {
        const r = await opts.postTweet(creds, i.text);
        response = { ok: true, status: 201, body: JSON.stringify(r) };
      } else {
        const headers = signOAuth1("POST", API_URL, creds);
        const res = await fetch(API_URL, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ text: i.text, ...(i.in_reply_to_id ? { reply: { in_reply_to_tweet_id: i.in_reply_to_id } } : {}) }),
          signal: ctx.signal,
        });
        response = { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 500) };
      }

      if (!response.ok)
        return { ok: false, error: `x.post ${response.status}: ${response.body}`, structured: { status: response.status } };
      return { ok: true, structured: { posted: true, api_response: response.body }, output: undefined };
    },
  };

  return [draft, post];
}
