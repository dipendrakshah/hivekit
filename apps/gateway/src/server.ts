/**
 * Gateway server — Bun.serve raw, no framework on the hot path (ARCH §1.1).
 *
 * One port (default 8787): static UI at /, healthz, REST auth endpoints,
 * JSON frames over WS at /ws. Zod validation happens exactly here — the WS
 * frame boundary. Keepalive: 25 s ping interval; a client silent for 60 s
 * (2 missed pongs) is closed server-side.
 */
import type { Database } from "bun:sqlite";
import {
  Frame,
  FrameTypes,
  NotYetImplemented,
  type FrameType,
  type Snapshot,
} from "@hivekit/protocol";
import { z } from "zod";
import type { AuthService } from "./auth";
import { parseCookie } from "./auth";
import { TokenRelay } from "./relay";
import type { JobRunner } from "./jobs";
import type { Redactor } from "./redact";

const PING_INTERVAL_MS = 25_000;
const IDLE_TIMEOUT_MS = 60_000;

type ErrorCode = "bad_frame" | "unauthorized" | "not_found" | "conflict" | "not_implemented" | "internal";

export interface ServerDeps {
  db: Database;
  auth: AuthService;
  jobs: JobRunner;
  redactor: Redactor;
  publicUrl: string;
  port?: number;
  webRoot?: string; // directory of the built web app; omitted = API-only
}

interface WsData {
  lastSeen: number;
}

export function createServer(deps: ServerDeps) {
  const { db, auth, jobs, redactor } = deps;

  const nowIso = () => new Date().toISOString();

  // ------------------------------------------------------------------ snapshot

  function snapshotFor(authMode: "passkey" | "token"): Snapshot {
    const threads = db
      .query("SELECT id, slug, title, created_at FROM threads ORDER BY created_at DESC")
      .all() as Array<{ id: string; slug: string; title: string; created_at: string }>;
    const latestThread = threads[0]?.id ?? null;
    let messages: Snapshot["messages"] = [];
    if (latestThread) {
      const rows = db
        .query(
          "SELECT id, thread_id, role, body, card_json, artifact_refs, created_at FROM messages WHERE thread_id = ? ORDER BY created_at",
        )
        .all(latestThread) as Array<{
        id: string;
        thread_id: string;
        role: string;
        body: string;
        card_json: string | null;
        artifact_refs: string;
        created_at: string;
      }>;
      messages = rows.map((m) => ({
        id: m.id,
        thread_id: m.thread_id,
        role: m.role as Snapshot["messages"][number]["role"],
        body: m.body,
        card: m.card_json ? JSON.parse(m.card_json) : null,
        artifact_refs: JSON.parse(m.artifact_refs) as string[],
        created_at: m.created_at,
      }));
    }
    const jobRows = db
      .query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50")
      .all() as Array<{
      id: string;
      thread_id: string;
      title: string;
      status: string;
      master_model: string | null;
      worker_model: string | null;
      usd: number;
      tokens_in: number;
      tokens_out: number;
    }>;
    const routineRows = db
      .query("SELECT id, name, cron, enabled, notify_policy, next_run_at FROM routines")
      .all() as Array<{
      id: string;
      name: string;
      cron: string;
      enabled: number;
      notify_policy: string;
      next_run_at: string | null;
    }>;
    const modelSettings = (
      db.query("SELECT value FROM settings WHERE key = 'models'").get() as { value: string } | undefined
    )?.value;

    return {
      you: { auth: authMode },
      threads,
      messages,
      jobs: jobRows.map((j) => ({
        id: j.id,
        thread_id: j.thread_id,
        title: j.title,
        status: j.status as Snapshot["jobs"][number]["status"],
        master_model: j.master_model ?? null,
        worker_model: j.worker_model ?? null,
        usd: j.usd ?? 0,
        tokens_in: j.tokens_in ?? 0,
        tokens_out: j.tokens_out ?? 0,
      })),
      routines: routineRows.map((r) => ({
        id: r.id,
        name: r.name,
        cron: r.cron,
        enabled: Boolean(r.enabled),
        notify: r.notify_policy as Snapshot["routines"][number]["notify"],
        next_run_at: r.next_run_at ?? null,
      })),
      models: modelSettings ? JSON.parse(modelSettings) : { master: null, worker: null },
      server_time: nowIso(),
    };
  }

  function insertMessage(
    threadId: string,
    role: "op" | "master" | "worker" | "system",
    body: string,
    card?: unknown,
  ): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const at = nowIso();
    db.query(
      "INSERT INTO messages (id, thread_id, role, body, card_json, artifact_refs) VALUES (?, ?, ?, ?, ?, '[]')",
    ).run(id, threadId, role, body, card === undefined ? null : JSON.stringify(card));
    return { id, created_at: at };
  }

  function broadcast(event: string, payload: unknown): void {
    const frame = JSON.stringify({ v: 1, type: event, payload });
    for (const [, ws] of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(redactor.apply(frame));
      }
    }
  }

  // --------------------------------------------------------------- WS handling

  const sockets = new Map<number, Bun.ServerWebSocket<WsData>>();
  let nextSocketId = 1;

  function sendError(ws: Bun.ServerWebSocket<WsData>, id: string | null, code: ErrorCode, message: string): void {
    ws.send(
      JSON.stringify({
        v: 1,
        id,
        type: "res.error",
        payload: { code, message: redactor.apply(message) },
      }),
    );
  }

  /** Relay factory: streams master-role text into a message row (≤250 ms flush). */
  function makeRelay(threadId: string): TokenRelay {
    let rowId: string | null = null;
    // `relay` is referenced inside its own sink closures; safe because those
    // callbacks only fire after construction returns.
    const relay = new TokenRelay({
      onChunk(text) {
        // Stream-01 echo: deltas broadcast immediately so clients see live text.
        broadcast("event.thread.delta", { thread_id: threadId, delta: text });
      },
      flush() {
        const text = relay.text;
        if (!rowId && text.length > 0) {
          const m = insertMessage(threadId, "master", text);
          rowId = m.id;
          broadcast("event.thread", {
            message: {
              id: m.id,
              thread_id: threadId,
              role: "master",
              body: text,
              card: null,
              artifact_refs: [],
              created_at: m.created_at,
            },
          });
        } else if (rowId) {
          db.query("UPDATE messages SET body = ? WHERE id = ?").run(text, rowId);
          // Live clients saw the partial body at insert time; the coalesced
          // updates land as an update event so the final text is complete.
          broadcast("event.thread.update", { id: rowId, thread_id: threadId, body: text });
        }
      },
    });
    return relay;
  }

  function handleFrame(ws: Bun.ServerWebSocket<WsData>, raw: string | Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return sendError(ws, null, "bad_frame", "frame is not valid JSON");
    }

    const env = Frame.safeParse(parsed);
    if (!env.success) {
      return sendError(ws, null, "bad_frame", env.error.issues[0]?.message ?? "malformed envelope");
    }
    const frame = env.data;
    ws.data.lastSeen = Date.now();

    if (frame.type.startsWith("event.")) {
      return sendError(ws, frame.id, "bad_frame", "events are server→client only");
    }
    if (!(frame.type in FrameTypes)) {
      return sendError(ws, frame.id, "bad_frame", `unknown frame type ${frame.type}`);
    }
    if ((NotYetImplemented as readonly string[]).includes(frame.type)) {
      return sendError(ws, frame.id, "not_implemented", `${frame.type} lands in a later stream`);
    }

    const schema = FrameTypes[frame.type as FrameType];
    const payload = schema.safeParse(frame.payload);
    if (!payload.success) {
      return sendError(ws, frame.id, "bad_frame", payload.error.issues[0]?.message ?? "bad payload");
    }
    const data = payload.data;

    switch (frame.type) {
      case "req.hello": {
        ws.send(
          JSON.stringify({ v: 1, id: frame.id, type: "res.hello", payload: snapshotFor("passkey") }),
        );
        return;
      }
      case "req.thread.create": {
        const { title } = data as { title: string };
        const id = crypto.randomUUID();
        const slugBase =
          title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) ||
          "thread";
        let slug = slugBase;
        let n = 2;
        while (db.query("SELECT 1 FROM threads WHERE slug = ?").get(slug)) {
          slug = `${slugBase}-${n++}`;
        }
        db.query("INSERT INTO threads (id, slug, title, workspace_path) VALUES (?, ?, ?, ?)").run(
          id,
          slug,
          title,
          `/data/threads/${slug}`,
        );
        ws.send(
          JSON.stringify({
            v: 1,
            id: frame.id,
            type: "res.thread.created",
            payload: { id, slug, title },
          }),
        );
        broadcast("event.threads.changed", {});
        return;
      }
      case "req.chat.send": {
        const { thread_id, body } = data as { thread_id: string; body: string };
        const thread = db.query("SELECT id FROM threads WHERE id = ?").get(thread_id);
        if (!thread) return sendError(ws, frame.id, "not_found", "thread does not exist");
        const msg = insertMessage(thread_id, "op", body);
        broadcast("event.thread", {
          message: {
            id: msg.id,
            thread_id,
            role: "op",
            body,
            card: null,
            artifact_refs: [],
            created_at: msg.created_at,
          },
        });

        // Echo job: the stream-01 stand-in for the master loop (stream 03).
        jobs.startEchoJob(thread_id, body, () => makeRelay(thread_id));
        ws.send(JSON.stringify({ v: 1, id: frame.id, type: "res.ok", payload: {} }));
        return;
      }
      case "req.job.cancel": {
        const { job_id, key } = data as { job_id: string; key: string };
        const ok = jobs.cancelJob(job_id, key);
        if (!ok) return sendError(ws, frame.id, "conflict", "job not cancellable");
        ws.send(JSON.stringify({ v: 1, id: frame.id, type: "res.ok", payload: {} }));
        return;
      }
      default:
        return sendError(ws, frame.id, "not_implemented", `${frame.type} lands in a later stream`);
    }
  }

  // ------------------------------------------------------------------- server

  const server = Bun.serve<WsData>({
    port: deps.port ?? 8787,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz") {
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      }

      // ---- Auth endpoints (REST; everything else is frames).
      if (url.pathname === "/api/auth/state" && req.method === "GET") {
        return Response.json({ has_passkey: auth.hasPasskey() });
      }
      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        return handleLogin(req);
      }
      if (url.pathname === "/api/auth/logout" && req.method === "POST") {
        const token = parseCookie(req.headers.get("cookie"));
        if (token) auth.logout(token);
        return new Response(null, {
          status: 204,
          headers: { "set-cookie": "hk_session=; Path=/; HttpOnly; Max-Age=0" },
        });
      }

      // ---- WebSocket upgrade (session cookie or ?token= for non-browser clients)
      if (url.pathname === "/ws") {
        const token = parseCookie(req.headers.get("cookie")) ?? url.searchParams.get("token");
        if (!token || !auth.validateSession(token)) {
          return new Response("unauthorized", { status: 401 });
        }
        const ok = server.upgrade(req, { data: { lastSeen: Date.now() } });
        if (!ok) return new Response("upgrade failed", { status: 500 });
        return undefined;
      }

      // ---- Static UI
      if (deps.webRoot) {
        return serveStatic(url.pathname, deps.webRoot);
      }
      return new Response("hivekit gateway\n", { headers: { "content-type": "text/plain" } });
    },

    websocket: {
      open(ws) {
        sockets.set(nextSocketId++, ws);
      },
      message(ws, raw) {
        handleFrame(ws, raw);
      },
      close(ws) {
        for (const [id, s] of sockets) {
          if (s === ws) sockets.delete(id);
        }
      },
    },

    error(error) {
      console.error(`[gateway] ${redactor.applyToError(error)}`);
      return new Response("internal error", { status: 500 });
    },
  });

  async function handleLogin(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
    const parsed = z.object({ passphrase: z.string().min(1).max(1024) }).safeParse(body);
    if (!parsed.success) return Response.json({ error: "invalid payload" }, { status: 400 });

    const hadPasskey = auth.hasPasskey();
    const result = await auth.login(parsed.data.passphrase, {
      secureCookie: deps.publicUrl.startsWith("https://"),
    });
    if (!result) return Response.json({ error: "invalid credentials" }, { status: 401 });

    // First-login setup: bootstrap token authenticated this request, so the
    // supplied passphrase becomes the owner passkey going forward.
    if (!hadPasskey) {
      await auth.setupPasskey(parsed.data.passphrase);
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": result.cookie,
      },
    });
  }

  function serveStatic(pathname: string, root: string): Response {
    const safePath = pathname.replaceAll("..", "");
    const file = Bun.file(`${root}${safePath === "/" || safePath === "" ? "/index.html" : safePath}`);
    return new Response(file);
  }

  // Keepalive: ping every 25 s; close after 60 s of silence (2 missed pongs).
  const keepalive = setInterval(() => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [id, ws] of sockets) {
      if (ws.data.lastSeen < cutoff) {
        ws.close(1000, "idle timeout");
        sockets.delete(id);
        continue;
      }
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, PING_INTERVAL_MS);

  return {
    server,
    stop(): void {
      clearInterval(keepalive);
      for (const [, ws] of sockets) ws.close(1001, "shutdown");
      server.stop(true);
    },
    broadcast,
  };
}