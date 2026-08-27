/**
 * Web tool definitions for the bus.
 * `rss.read` reuses ssrfFetch (feeds are just URLs) and extracts items
 * without a dependency — two tiny parsers cover RSS2/Atom, which is what
 * operator-configured sources actually are in v1.
 */
import { z } from "zod";
import type { ToolDef } from "@hivekit/tools";
import { SsrfBlocked, ssrfFetch, wrapUntrusted } from "./web";

export interface FeedItem {
  title: string;
  link: string;
  published?: string;
  summary?: string;
}

/** Minimal RSS 2.0 / Atom extractor: elements we can state, not a YAML of XML edge cases. */
export function extractFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const blockRe = /<(item|entry)[\s>]([\s\S]*?)<\/\1>/gi;
  for (const m of xml.matchAll(blockRe)) {
    const block = m[2] ?? "";
    const pick = (tag: string): string | undefined => {
      const t = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "i").exec(
        block,
      );
      return t?.[1]?.trim();
    };
    const link =
      /<link[^>]*href="([^"]+)"/i.exec(block)?.[1] ?? pick("link") ?? pick("guid");
    const title = decodeEntities(
      (pick("title") ?? "").replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1").replace(/<[^>]+>/g, " "),
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!title && !link) continue;
    items.push({
      title,
      link: link ? decodeEntities(link) : "",
      published: pick("pubDate") ?? pick("updated") ?? pick("published"),
      summary: stripTags(pick("description") ?? pick("summary") ?? pick("content") ?? ""),
    });
  }
  return items;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const WebFetchInput = z.object({
  url: z.string().url(),
  /** Reader workers only need extracted text; structured callers may want raw. */
});

export interface ConnectorsDeps {
  fetchImpl?: typeof fetch;
}

export function makeWebTools(_deps: ConnectorsDeps = {}): Array<ToolDef<unknown>> {
  void _deps; // ssrfFetch always uses global fetch so SSRF layer is testable end-to-end
  const webFetch: ToolDef<unknown> = {
    name: "web.fetch",
    kind: "web",
    inputSchema: WebFetchInput as unknown as import("zod").ZodType<unknown>,
    async execute(input) {
      const { url } = input as { url: string };
      try {
        const r = await ssrfFetch(url);
        const body = wrapUntrusted(r.finalUrl, r.body);
        return {
          ok: true,
          output:
            r.truncated || r.status >= 400
              ? `${body}\n[${r.status}${r.truncated ? " · truncated at 2MB" : ""}]`
              : body,
          structured: { status: r.status, finalUrl: r.finalUrl, truncated: r.truncated },
        };
      } catch (err) {
        if (err instanceof SsrfBlocked)
          return { ok: false, error: `refused: ${err.reason}`, structured: { refused: true } };
        throw err;
      }
    },
  };

  const rssRead: ToolDef<unknown> = {
    name: "rss.read",
    kind: "web",
    inputSchema: z.object({ url: z.string().url() }) as unknown as import("zod").ZodType<unknown>,
    async execute(input) {
      const { url } = input as { url: string };
      try {
        const r = await ssrfFetch(url);
        const items = extractFeed(r.body);
        const rendered = items
          .slice(0, 50)
          .map((it) => `- ${it.title}\n  ${it.link}${it.published ? `\n  ${it.published}` : ""}${it.summary ? `\n  ${it.summary}` : ""}`)
          .join("\n");
        return {
          ok: true,
          output: wrapUntrusted(r.finalUrl, `${items.length} items\n${rendered}`),
          structured: { count: items.length, truncated: r.truncated },
        };
      } catch (err) {
        if (err instanceof SsrfBlocked)
          return { ok: false, error: `refused: ${err.reason}`, structured: { refused: true } };
        throw err;
      }
    },
  };

  return [webFetch, rssRead];
}
