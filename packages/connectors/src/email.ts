/**
 * Email connector (FR-K4).
 *
 * `email.fetch`  — IMAP poll via imapflow over an app password; every fetched
 *                  body is wrapped untrusted at ingest.
 * `email.send`   — SMTP via the in-package client; always_ask by §4.5, so a
 *                  call without receipt returns an approval card carrying the
 *                  full message preview as its diff_preview.
 *
 * Stealth-provider scope rule: enforcement lives at the config→tool wiring
 * layer (the gateway refuses to register email tools when models.worker
 * provider is flagged anonymous) — documented here so the default "blocked"
 * is visible where the tool itself is defined.
 */
import { z } from "zod";
import type { ToolDef } from "@hivekit/tools";
import { sendMail } from "./smtp";
import { wrapUntrustedExternal } from "./web";
import type { SmtpConfig } from "./smtp";

export interface ImapConfig {
  host: string;
  port?: number;
  folders: string[];
}

export interface FetchOne {
  uid: number;
  from: string;
  subject: string;
  date: string;
  body: string;
}

export interface ImapClientOptions {
  host: string;
  port?: number;
  auth: { user: string; pass: string };
  logger?: boolean;
}

/**
 * Thin seam over imapflow so tests can inject a fake; import kept dynamic —
 * production uses the real lib lazily to keep boot fast even if mail is off.
 */
export interface MailboxPoller {
  poll(folder: string, opts: { sinceUid?: number }, onMessage: (m: FetchOne) => Promise<void>): Promise<number>;
}

export function realImapPoller(cfg: ImapClientOptions): MailboxPoller {
  return {
    async poll(folder, { sinceUid = 0 } = {}, onMessage): Promise<number> {
      const { ImapFlow } = await import("imapflow");
      const client = new ImapFlow({
          host: cfg.host,
          port: cfg.port ?? 993,
          auth: { user: cfg.auth.user, pass: cfg.auth.pass },
          tls: { servername: cfg.host },
        });
      try {
        await client.connect();
        const lock = await client.getMailboxLock(folder);
        let handled = 0;
        try {
          for await (const msg of client.fetch(
            { since: new Date(Date.now() - 36 * 3_600_000) },
            { envelope: true, bodyStructure: false, source: true, uid: true },
          )) {
            void lock;
            if (msg.uid <= sinceUid) continue;
            const env = msg.envelope ?? {};
            const text = extractText(msg.source?.toString("utf8") ?? "");
            await onMessage({
              uid: msg.uid,
              from: env.from?.[0]?.address ?? "",
              subject: env.subject ?? "(no subject)",
              date: (env.date ? new Date(env.date) : new Date()).toISOString(),
              body: text.slice(0, 20_000),
            });
            handled++;
          }
        } finally {
          lock.release();
        }
        return handled;
      } finally {
        await client.logout().catch(() => {});
      }
    },
  };
}

function extractText(rawMime: string): string {
  // Deliberately minimal: headers split, first text/plain section.
  const boundarySplit = rawMime.split(/\r?\n\r?\n/);
  const [, ...rest] = boundarySplit;
  return rest.join("\n\n").replace(/--[^\r\n]+/g, "").trim().slice(0, 60_000);
}

export function makeEmailTools(deps: {
  smtp: () => Promise<SmtpConfig | null>;
  poller?: MailboxPoller;
  imapConfig?: ImapConfig;
}): Array<ToolDef<unknown>> {
  const SendInput = z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(50_000),
  });
  const PollInput = z.object({ folder: z.string().default("INBOX") });

  return [
    {
      name: "email.fetch",
      kind: "fetch_mail",
      inputSchema: PollInput as unknown as import("zod").ZodType<unknown>,
      describe(input) {
        const i = input as { folder?: string };
        return { title: `poll inbox (${i.folder ?? deps.imapConfig?.folders[0] ?? "INBOX"})` };
      },
      execute: async (input, ctx) => {
        const i = input as { folder?: string };
        const poller = deps.poller ?? realImapPoller({
          host: "",
          auth: { user: "", pass: "" }, // gateway injects creds-backed poller instead
          logger: false,
        });
        void poller;
        // The REAL path: gateway passes deps.poller with vault creds. This
        // fallback only errors loudly rather than silently returning [].
        if (!deps.poller)
          return { ok: false, error: "email.poll not wired — connector credentials missing", structured: {} };

        const messages: FetchOne[] = [];
        await deps.poller.poll(i.folder ?? "INBOX", {}, async (m) => {
          messages.push(m);
        });
        void ctx;
        const digest = messages.map((m) => `${m.from}\t${m.subject}\t${m.date}`).join("\n");
        return {
          ok: true,
          output: wrapUntrustedExternal(`imap:${i.folder ?? "INBOX"}`, digest || "(empty mailbox)"),
          structured: { count: messages.length },
        };
      },
    },
    {
      name: "email.send",
      kind: "send_mail",
      inputSchema: SendInput as unknown as import("zod").ZodType<unknown>,
      describe(input) {
        const i = input as { to: string; subject: string; body: string };
        return {
          title: `send email → ${i.to}`,
          diff_preview: `Subject: ${i.subject}\n\n${i.body}`,
          payload_summary: { to: i.to, bytes: String(i.body.length) },
        };
      },
      execute: async (input, ctx) => {
        const cfg = await deps.smtp();
        if (!cfg) return { ok: false, error: "SMTP credentials missing", structured: {} };
        const i = input as { to: string; subject: string; body: string };
        void ctx;
        const r = await sendMail(cfg, i);
        return { ok: true, structured: { sent: r.accepted, to: i.to, subject: i.subject } };
      },
    },
  ];
}
