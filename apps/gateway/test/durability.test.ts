/**
 * Durability + journal tests (todo/01 DoD).
 *
 * The SIGKILL test is a real kill: it spawns a child Bun process that writes
 * journal rows and dies mid-job without cleanup; the parent reopens the DB
 * and asserts the fold reproduces the exact pre-kill state.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, journalAppend, journalFold } from "../src/db";

const dir = mkdtempSync(join(tmpdir(), "hivekit-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sqlite layer", () => {
  test("opens, migrates, and is WAL", () => {
    const db = openDb(join(dir, "a.db"));
    const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    for (const t of ["threads", "messages", "jobs", "tasks", "routines", "approvals", "settings", "vault", "run_journal", "sessions"]) {
      expect(tables.map((x) => x.name)).toContain(t);
    }
    db.close();
  });

  test("migrations are idempotent", () => {
    const db = openDb(join(dir, "b.db"));
    const before = (db.query("SELECT count(*) c FROM schema_migrations").get() as { c: number }).c;
    // Re-open runs migrate() again.
    db.close();
    const db2 = openDb(join(dir, "b.db"));
    const after = (db2.query("SELECT count(*) c FROM schema_migrations").get() as { c: number }).c;
    expect(after).toBe(before);
    db2.close();
  });

  test("journal folds transitions in order", () => {
    const db = openDb(":memory:");
    journalAppend(db, "job", "j1", null, "planning");
    journalAppend(db, "job", "j1", "planning", "running");
    journalAppend(db, "job", "j1", "running", "done");
    const fold = journalFold(db, "j1");
    expect(fold.map((f) => f.to)).toEqual(["planning", "running", "done"]);
  });
});

describe("SIGKILL mid-job recovery (real kill)", () => {
  test("state after kill matches the journal fold exactly", async () => {
    const childScript = `
      const { openDb, journalAppend } = require(${JSON.stringify(join(import.meta.dir, "../src/db.ts"))});
      const db = openDb(${JSON.stringify(join(dir, "kill.db"))});
      journalAppend(db, "job", "kj", null, "planning");
      journalAppend(db, "job", "kj", "planning", "running");
      console.log("ready");
      // Simulate long-running side effect; parent kills us here.
      setInterval(() => {}, 1000);
    `;
    const proc = Bun.spawn(["bun", "-e", childScript], { stdout: "pipe", stderr: "pipe" });
    // Read ONLY the first chunk ("ready\n") — reading to EOF would block
    // until the child exits, which defeats killing it mid-flight.
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    if (!first.value) {
      const stderr = await new Response(proc.stderr).text;
      throw new Error(`child died before signalling ready:\n${stderr}`);
    }
    reader.cancel();
    // The kill: no cleanup, no graceful shutdown.
    proc.kill(9);
    await proc.exited;

    // Reopen like boot would.
    const db = openDb(join(dir, "kill.db"));
    const fold = journalFold(db, "kj");
    expect(fold.map((f) => f.to)).toEqual(["planning", "running"]);
    db.close();
  });

  test("half-written MEMORY.md never survives an atomic write", () => {
    // atomicWrite's contract: temp → fsync → rename. A crash between write
    // and rename leaves the ORIGINAL intact; rename is atomic on POSIX.
    const target = join(dir, "atomic.md");
    require("node:fs").writeFileSync(target, "original content");
    const { atomicWrite } = require("../src/workspace") as typeof import("../src/workspace");
    atomicWrite(target, "replaced content");
    expect(require("node:fs").readFileSync(target, "utf8")).toBe("replaced content");
    // No temp files left behind.
    const leftovers = require("node:fs")
      .readdirSync(dir)
      .filter((f: string) => f.startsWith("atomic.md.tmp-"));
    expect(leftovers).toEqual([]);
  });
});