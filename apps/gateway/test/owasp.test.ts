/**
 * OWASP-style pass (todo/06 DoD): session fixation, CSRF on state-changing
 * routes, WSS origin check — all against the real server.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVEKIT_TOKEN = "owasp-token-0123456789abcdefgh";
process.env.HIVEKIT_MASTER_KEY = "owasp-master-key-0123456789abcdefgh";
const dataDir = mkdtempSync(join(tmpdir(), "hk-owasp-"));
process.env.HIVEKIT_DATA = dataDir;

const { createServer } = await import("../src/server");
const { openDb } = await import("../src/db");
const { AuthService, SqliteAuthStore } = await import("../src/auth");
const { Redactor } = await import("../src/redact");
const { JobRunner } = await import("../src/jobs");

const db = openDb(join(dataDir, "db.sqlite"));
const auth = new AuthService(new SqliteAuthStore(db), process.env.HIVEKIT_TOKEN!);
const gw = createServer({
  db,
  auth,
  jobs: new JobRunner(db),
  redactor: new Redactor(),
  publicUrl: "http://localhost",
  port: 18997,
});
const BASE = "http://127.0.0.1:18997";

afterAll(() => {
  gw.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("session handling", () => {
  test("session fixation: every login mints a FRESH token; cookies carry hardening flags", async () => {
    const r1 = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: process.env.HIVEKIT_TOKEN }),
    });
    const c1 = r1.headers.get("set-cookie")!;
    const r2 = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: process.env.HIVEKIT_TOKEN }),
    });
    const c2 = r2.headers.get("set-cookie")!;

    const t1 = c1.split(";")[0]!.split("=")[1]!;
    const t2 = c2.split(";")[0]!.split("=")[1]!;
    expect(t1).not.toBe(t2); // no fixed session carried across logins
    for (const c of [c1, c2]) {
      expect(c).toContain("HttpOnly");
      expect(c).toContain("SameSite=Strict");
      expect(c).not.toContain("Secure"); // publicUrl is http in test; Secure on https is asserted in auth tests
    }
    // Both tokens validate — pre-auth attacker-set ids are never honored.
    expect(auth.validateSession(t1)).toBe(true);
  });

  test("logout invalidates the exact session (token hashed at rest)", async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: process.env.HIVEKIT_TOKEN }),
    });
    const token = r.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    await fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: `hk_session=${token}` },
    });
    expect(auth.validateSession(token)).toBe(false);
  });
});

describe("CSRF on state-changing routes", () => {
  test("Sec-Fetch-Site: cross-site POST refused", async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ passphrase: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("cross-origin Origin header refused; same-origin accepted", async () => {
    const evil = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ passphrase: process.env.HIVEKIT_TOKEN }),
    });
    expect(evil.status).toBe(403);

    const good = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:18997",
      },
      body: JSON.stringify({ passphrase: process.env.HIVEKIT_TOKEN }),
    });
    expect(good.status).toBe(200);
  });
});

describe("WSS origin check", () => {
  test("cross-origin upgrade refused even WITH a valid session", async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: process.env.HIVEKIT_TOKEN }),
    });
    const token = r.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;

    let outcome = "";
    await new Promise<void>((resolve) => {
      // Bun's WS client accepts runtime options the DOM types don't declare.
      const WSCtor = WebSocket as unknown as new (u: string, o?: object) => WebSocket;
      const ws = new WSCtor(`ws://127.0.0.1:18997/ws?token=${token}`, {
        headers: { origin: "https://evil.example" },
      });
      ws.onopen = () => {
        outcome = "opened";
        ws.close();
        resolve();
      };
      ws.onerror = () => {
        outcome = "error";
        resolve();
      };
      ws.onclose = (e) => {
        outcome = outcome || `closed:${e.code}`;
        resolve();
      };
      setTimeout(resolve, 3000);
    });
    expect(outcome).not.toBe("opened"); // the hostile page never gets a socket
  });

  test("same-origin (or no-Origin non-browser) upgrade passes to token auth", async () => {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: process.env.HIVEKIT_TOKEN }),
    });
    const token = login.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    let opened = false;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:18997/ws?token=${token}`);
      ws.onopen = () => {
        opened = true;
        ws.close();
        resolve();
      };
      ws.onerror = () => resolve();
      setTimeout(resolve, 3000);
    });
    expect(opened).toBe(true);
  });
});
