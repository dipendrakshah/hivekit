/**
 * Server smoke — boots the REAL Bun.serve stack and drives the exact frame
 * sequence the web app uses: login → hello → thread.create → chat.send →
 * stream deltas → system message. This is the app-contract test: break the
 * client and it fails here first.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVEKIT_TOKEN = process.env.HIVEKIT_TOKEN || "smoke-token-0123456789abcdef";
process.env.HIVEKIT_MASTER_KEY = process.env.HIVEKIT_MASTER_KEY || "smoke-master-key-0123456789abcdef";

const dataDir = mkdtempSync(join(tmpdir(), "hk-smoke-"));
process.env.HIVEKIT_DATA = dataDir;
process.env.HIVEKIT_WEB_ROOT = join(import.meta.dir, "../../web"); // serves index via src fallback? no — static only from dist; API-only path fine

const { createServer } = await import("../src/server");
const { openDb } = await import("../src/db");
const { AuthService, SqliteAuthStore } = await import("../src/auth");
const { Redactor } = await import("../src/redact");
const { JobRunner } = await import("../src/jobs");
const { Vault } = await import("../src/vault");

const db = openDb(join(dataDir, "hivekit.db"));
const redactor = new Redactor();
const vault = new Vault(
  {
    get: () => null,
    set: () => {},
    delete: () => {},
  },
  process.env.HIVEKIT_MASTER_KEY!,
);
const auth = new AuthService(new SqliteAuthStore(db), process.env.HIVEKIT_TOKEN!);
const jobs = new JobRunner(db);
const gw = createServer({ db, auth, jobs, redactor, publicUrl: "http://localhost", port: 18991 });
jobs.setBroadcaster(gw.broadcast);
const BASE = "http://127.0.0.1:18991";

afterAll(() => {
  gw.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("web app contract over the real server", () => {
  let cookie = "";

  test("GET / serves something (UI or api banner)", async () => {
    const res = await fetch(BASE);
    expect(res.status).toBeLessThan(500);
  });

  test("login via bootstrap token sets cookie + passkey (first-run)", async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // First-run: the bootstrap token IS the first passphrase (auth.ts contract);
      // it becomes the owner passkey after this call.
      body: JSON.stringify({ passphrase: process.env.HIVEKIT_TOKEN }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    cookie = setCookie.split(";")[0]!;
    expect(cookie.startsWith("hk_session=")).toBe(true);
  });

  test("WS frames: hello → thread.create → chat.send → echo stream", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:18991/ws?token=${cookie.split("=")[1]}`);
    const frames: Array<Record<string, unknown>> = [];
    let threadId = "";

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws timeout")), 10_000);
      ws.onmessage = (ev) => {
        const f = JSON.parse(ev.data as string);
        frames.push(f);
        if (process.env.HK_DEBUG) console.log("[ws frame]", f.type);
        if (f.type === "res.hello") {
          ws.send(JSON.stringify({ v: 1, id: "t1", type: "req.thread.create", payload: { title: "smoke thread" } }));
        } else if (f.type === "res.thread.created") {
          threadId = (f.payload as { id: string }).id;
          ws.send(JSON.stringify({ v: 1, id: "c1", type: "req.chat.send", payload: { thread_id: threadId, body: "hello hive" } }));
        } else if (f.type === "event.job") {
          const job = (f.payload as { job: { status: string; id: string } }).job;
          if (process.env.HK_DEBUG) console.log("[job]", job.status, job.id.slice(0, 8));
          if (job.status === "done") {
            clearTimeout(timer);
            resolve();
          }
        }
      };
      ws.onopen = () => ws.send(JSON.stringify({ v: 1, id: "h1", type: "req.hello", payload: {} }));
      ws.onerror = (e) => reject(new Error(`ws error ${JSON.stringify(e)}`));
      ws.onclose = (e) => { if (frames.length === 0) reject(new Error(`ws closed early code=${e.code} reason=${e.reason}`)); };
    });
    ws.close();

    const types = frames.map((f) => f.type);
    expect(types).toContain("res.hello");
    expect(types).toContain("res.thread.created");
    expect(types).toContain("event.thread.delta");
    expect(types).toContain("event.thread"); // final message row
    // Contract: first event.thread may be a partial flush; the LAST
    // event.thread.update carries the full body (coalesced relay).
    const finalUpdate = frames
      .filter((f) => f.type === "event.thread.update")
      .map((f) => f.payload as { body: string })
      .at(-1);
    expect(finalUpdate?.body).toContain("echo: hello hive");
    const firstRow = frames.find((f) => f.type === "event.thread") as { payload: { message: { id: string } } };
    expect(firstRow).toBeDefined();
    expect(finalUpdate?.body.length).toBeGreaterThanOrEqual("echo: hello hive".length);
    void threadId;
  });

  test("unauthenticated WS is rejected", async () => {
    const res = await fetch(`${BASE.replace("http", "ws")}/ws`.replace("ws://", "http://"));
    void res;
    const res2 = await fetch(`${BASE}/ws`);
    expect(res2.status).toBe(401);
  });
});
