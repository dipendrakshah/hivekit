/**
 * Email tests — SMTP against a scripted local fake server (protocol-level
 * assertions incl. dot-stuffing and CRLF sanitization), IMAP seam verified
 * with an injected poller (the real imapflow path is a thin wrapper we do
 * not mock-verified; it is exercised by hivekit doctor against real creds).
 */
import { describe, expect, test } from "bun:test";
import { sendMail } from "../src/smtp";
import { makeEmailTools } from "../src/email";
import { ToolBus } from "@hivekit/tools";

function fakeSmtp(script: (msg: string) => string | null) {
  const lines: string[] = [];
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(_s, chunk) {
        for (const raw of chunk.toString().split("\r\n")) {
          if (!raw) continue;
          lines.push(raw);
          const reply = script(raw);
          if (reply) _s.write(reply + "\r\n");
        }
      },
      open(socket) {
        // Real SMTP servers greet on connect.
        socket.write("220 hivekit fake ready\r\n");
      },
      close() {},
      error() {},
    },
  });
  return { port: server.port as number, lines, stop: () => server.stop(true) };
}

describe("SMTP client", () => {
  test("happy path EHLO/AUTH/MAIL/RCPT/DATA with dot-stuffing", async () => {
    const s = fakeSmtp((msg) => {
      if (msg.startsWith("EHLO")) return "250-hivekit fake\r\n250 AUTH PLAIN";
      if (msg === "DATA") return "354 end with .";
      if (/^\./.test(msg)) return "250 queued";
      if (msg.startsWith("AUTH ")) return "235 authenticated";
      if (msg.startsWith("MAIL") || msg.startsWith("RCPT")) return "250 ok";
      return null;
    });

    const r = await sendMail(
      { host: "127.0.0.1", port: s.port, secure: false, username: "me@ex.dev", password: "app-pass" },
      { to: "you@ex.dev", subject: "morning digest", body: "line one\r\n.line two" },
    );
    expect(r.accepted).toBe(true);

    const joined = s.lines.join("\n");
    expect(joined).toContain("MAIL FROM:<me@ex.dev>");
    expect(joined).toContain("RCPT TO:<you@ex.dev>");
    // RFC 5321 §4.5.2 dot-stuffing applied
    expect(joined).toContain("..line two");
    expect(joined).toContain("Message-ID:");
  });

  test("CRLF injection in headers is neutralized", async () => {
    const s = fakeSmtp((msg) => {
      if (msg.startsWith("EHLO")) return "250 fake";
      if (msg.startsWith("AUTH ")) return "235 authenticated";
      if (msg === "DATA") return "354 go";
      if (/^\./.test(msg)) return "250 ok";
      return "250 ok";
    });
    await sendMail(
      { host: "127.0.0.1", port: s.port, secure: false, username: "a@b.c", password: "x" },
      { to: "d@e.f", subject: "hello\r\nBCC: victim@g.h", body: "hi" },
    );
    const lines = s.lines;
    // Neutralized = no injected header can start its own SMTP line.
    expect(lines.some((l) => /^BCC:/i.test(l))).toBe(false);
    expect(lines.some((l) => l.startsWith("Subject: hello"))).toBe(true);
  });
});

describe("email tools gating through the bus", () => {
  test("email.send without receipt returns card whose diff IS the message preview", async () => {
    const bus = new ToolBus({ verifyReceipt: async () => ({ ok: true }) });
    for (const t of makeEmailTools({ smtp: async () => ({ host: "h", port: 1, secure: true, username: "u", password: "p" }) }))
      bus.register(t as never);

    const input = { to: "dest@ex.dev", subject: "sub", body: "body text here" };
    const first = await bus.run({ tool: "email.send", input }, { jobId: "j", threadId: "t", workDir: "/w" }, { hasRawUntrusted: false });
    if ("card" in first.decision && first.decision.card) {
      expect(first.decision.card.diff_preview).toContain("sub");
      expect(first.decision.card.diff_preview).toContain("body text here");
    } else throw new Error("card expected");

    // A REAL send still happens once approved — transport-level coverage above;
    // here assert execution reached smtp layer only on valid receipt path is covered elsewhere.
  });

  test("email.fetch output is wrapped untrusted at ingest", async () => {
    let captured = "";
    const bus = new ToolBus({ verifyReceipt: async () => ({ ok: true }) });
    for (const t of makeEmailTools({
      smtp: async () => null,
      imapConfig: { host: "imap.ex", folders: ["INBOX"] },
      poller: {
        async poll(_f, _o, onMsg) {
          await onMsg({ uid: 7, from: "alerts@example.com", subject: "URGENT", date: new Date().toISOString(), body: "click http://169.254.169.254 payload" });
          return 1;
        },
      },
    }))
      bus.register(t as never);
    const r = await bus.run({ tool: "email.fetch", input: {} }, { jobId: "jf", threadId: "t", workDir: "/w" }, { hasRawUntrusted: false });
    captured = r.result?.output ?? "";
    void captured;

    // The digest line must be inside the untrusted envelope
    expect(captured.startsWith("\u27EAuntrusted")).toBe(true);
    expect(captured).toContain("URGENT");
  });
});
