/**
 * Minimal SMTP client — implicit TLS or STARTTLS, AUTH PLAIN.
 *
 * Why not nodemailer: connectors commit to zero heavy deps, and v1 scope
 * (Gmail app passwords + custom SMTP) needs only EHLO → [STARTTLS] →
 * AUTH PLAIN → MAIL/RCPT/DATA. Reply handling follows RFC 5321 §4.2 exactly:
 * "250-" continues, "250 " completes.
 *
 * Honest limits: no DKIM signing, no 8BITMIME, no attachments (v1.1).
 * Tests run against a local fake server — never the network.
 */
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { createHash } from "node:crypto";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  /** envelope sender; defaults to username */
  from?: string;
}

export interface MailInput {
  to: string;
  subject: string;
  body: string;
}

interface Reply {
  code: number;
  /** Continuation lines including the final one, code prefix stripped. */
  text: string[];
  complete: boolean;
}

function makeParser(onReply: (r: Reply) => void): (chunk: string) => void {
  let buf = "";
  let acc: Reply | null = null;
  return (chunk: string) => {
    buf += chunk;
    for (;;) {
      const i = buf.indexOf("\r\n");
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m || !m[1]) continue; // tolerate stray bytes
      if (!acc) acc = { code: Number.parseInt(m[1], 10), text: [], complete: false };
      acc.text.push(m[3] ?? "");
      if (m[2] === " ") {
        acc.complete = true;
        onReply(acc);
        acc = null;
      }
    }
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function writeLine(sock: Socket, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    sock.write(`${text}\r\n`, (err) => (err ? reject(err) : resolve())),
  );
}

function sanitize(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

/** All-in-one connection lifecycle; STARTTLS upgrades mid-conversation. */
export async function sendMail(cfg: SmtpConfig, mail: MailInput): Promise<{ accepted: true }> {
  let socket = await new Promise<TLSSocket | Socket>((resolve, reject) => {
    if (cfg.secure) {
      const s = tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    } else {
      const s = netConnect({ host: cfg.host, port: cfg.port });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    }
  });

  const queue: Reply[] = [];
  let handleData: ((c: string) => void) | null = null;
  socket.on("data", (c: string) => handleData?.(c));

  const awaitReply = async (): Promise<Reply> => {
    for (;;) {
      const r = queue.shift();
      if (r) return r;
      await sleep(5);
    }
  };
  const cmd = async (text?: string): Promise<Reply> => {
    if (text !== undefined) await writeLine(socket, text);
    return awaitReply();
  };
  const need = (r: Reply, codes: number[]): Reply => {
    if (!codes.includes(r.code))
      throw new Error(`smtp ${r.code} unexpected (wanted ${codes.join("/")})`);
    return r;
  };

  try {
    handleData = makeParser((r) => queue.push(r));
    need(await cmd(), [220]); // greeting

    let ehlo = await cmd("EHLO hivekit.local");
    need(ehlo, [250]);
    const capabilities = ehlo.text.join("\n");

    if (!cfg.secure && /STARTTLS/i.test(capabilities)) {
      need(await cmd("STARTTLS"), [220]);
      // Remove data listeners, rehandshake TLS over the live TCP stream,
      // reattach the same reply plumbing.
      socket.removeAllListeners("data");
      const upgraded = tlsConnect(
        { socket, servername: cfg.host },
        () => {},
      );
      socket = upgraded;
      socket.setEncoding("utf8");
      socket.on("data", (c: string) => handleData?.(c));
      need(await cmd("EHLO hivekit.local"), [250]);
    }

    const token = Buffer.from(`\0${cfg.username}\0${cfg.password}`).toString("base64");
    need(await cmd(`AUTH PLAIN ${token}`), [235]);
    need(await cmd(`MAIL FROM:<${sanitize(cfg.from ?? cfg.username)}>`), [250]);
    need(await cmd(`RCPT TO:<${sanitize(mail.to)}>`), [250, 251]);
    need(await cmd("DATA"), [354]);

    const messageId = `<hk-${createHash("sha256").update(mail.body).digest("hex").slice(0, 24)}@hivekit.local>`;
    const payload =
      [
        `From: <${sanitize(cfg.from ?? cfg.username)}>`,
        `To: <${sanitize(mail.to)}>`,
        `Subject: ${sanitize(mail.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: ${messageId}`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        mail.body.replace(/^\./gm, ".."),
      ].join("\r\n") + "\r\n.";

    await writeLine(socket, payload);
    need(await awaitReply(), [250]);
    socket.end();
    socket.destroySoon?.();
    return { accepted: true };
  } finally {
    handleData = null;
    try {
      socket.end();
    } catch {
      /* already closed */
    }
  }
}
