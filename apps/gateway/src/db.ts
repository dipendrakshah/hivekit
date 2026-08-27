/**
 * SQLite layer — bun:sqlite, WAL, prepared statements, raw SQL, no ORM
 * (ARCHITECTURE §1.1, §4.2). `synchronous=NORMAL` is safe under WAL and keeps
 * writes ≈100 µs. Migrations run on boot; each is a transaction.
 *
 * The run journal (§4.2 crash safety): every job/task transition persists
 * BEFORE its side effect. State is a fold over journal rows, so SIGKILL
 * mid-job resumes exactly — stream 01 proves it with an actual kill test.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface DbRow_Migration {
  version: number;
  name: string;
  applied_at: string;
}

const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "core-tables",
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  workspace_path  TEXT NOT NULL,
  memory_hash     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES threads(id),
  role           TEXT NOT NULL CHECK (role IN ('op','master','worker','system')),
  body           TEXT NOT NULL,
  card_json      TEXT,
  artifact_refs  TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(id),
  title         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('planning','running','needs_approval','merging','done','failed','cancelled')),
  master_model  TEXT,
  worker_model  TEXT,
  budget_usd    REAL NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  usd           REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_thread ON jobs(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status) WHERE status IN ('planning','running','needs_approval','merging');

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  idx             INTEGER NOT NULL,
  title           TEXT NOT NULL,
  spec_json       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued','running','ok','failed','blocked')),
  model_id        TEXT,
  artifacts_json  TEXT NOT NULL DEFAULT '[]',
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id, idx);

CREATE TABLE IF NOT EXISTS routines (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  cron             TEXT NOT NULL,
  prompt_template  TEXT NOT NULL,
  connector_scope  TEXT NOT NULL DEFAULT '[]',
  notify_policy    TEXT NOT NULL DEFAULT 'on-approval-only'
                   CHECK (notify_policy IN ('always','on-approval-only','silent-until-done')),
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_run_at      TEXT,
  next_run_at      TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  job_id        TEXT REFERENCES jobs(id),
  action_kind   TEXT NOT NULL CHECK (action_kind IN
                  ('site_push','x_post','email_send','exec','delete')),
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  decided_by    TEXT,
  decided_at    TEXT,
  model         TEXT,
  diff_ref      TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault (
  ref         TEXT PRIMARY KEY,
  ciphertext  BLOB NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Run journal: append-only. Every state transition lands here before any
-- side effect executes. Recovery folds this log forward on boot.
CREATE TABLE IF NOT EXISTS run_journal (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL,
  ref_id    TEXT NOT NULL,
  from_state TEXT,
  to_state  TEXT NOT NULL,
  detail_json TEXT,
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_journal_ref ON run_journal(ref_id, seq);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL
);
`,
  },
];

export function openDb(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (
      db.query("SELECT version FROM schema_migrations").all() as Array<{ version: number }>
    ).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    });
    tx();
  }
}

// ---------------------------------------------------------------------------
// Journal helpers — persist-then-act is the only legal order.
// ---------------------------------------------------------------------------

export function journalAppend(
  db: Database,
  kind: string,
  refId: string,
  fromState: string | null,
  toState: string,
  detail?: unknown,
): void {
  db.query(
    "INSERT INTO run_journal (kind, ref_id, from_state, to_state, detail_json) VALUES (?, ?, ?, ?, ?)",
  ).run(kind, refId, fromState, toState, detail === undefined ? null : JSON.stringify(detail));
}

/** Fold the journal forward for one entity; returns transitions in order. */
export function journalFold(
  db: Database,
  refId: string,
): Array<{ kind: string; from: string | null; to: string }> {
  return (
    db
      .query("SELECT kind, from_state, to_state FROM run_journal WHERE ref_id = ? ORDER BY seq")
      .all(refId) as Array<{ kind: string; from_state: string | null; to_state: string }>
  ).map((r) => ({ kind: r.kind, from: r.from_state ?? null, to: r.to_state }));
}