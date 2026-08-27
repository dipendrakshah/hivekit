/**
 * Gateway entrypoint — wires config, db, vault, auth, jobs, server.
 *
 * Startup is fail-fast: a missing HIVEKIT_TOKEN or HIVEKIT_MASTER_KEY is a
 * clear error naming the variable, never a silent fallback (todo/01).
 */
import { loadConfig } from "./config";
import { openDb } from "./db";
import { Vault } from "./vault";
import { AuthService, SqliteAuthStore } from "./auth";
import { Redactor } from "./redact";
import { JobRunner } from "./jobs";
import { createServer } from "./server";
import { mkdirSync } from "node:fs";

function fail(message: string): never {
  console.error(`hivekit: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const env = process.env;

  let cfg;
  try {
    cfg = loadConfig(env);
  } catch (err) {
    fail(`config error — ${(err as Error).message}`);
  }

  const tokenEnv = cfg.auth.token_env;
  const keyEnv = cfg.auth.vault_key_env;
  const bootstrapToken = env[tokenEnv] ?? "";
  if (!bootstrapToken) {
    fail(`${tokenEnv} is not set. Generate one with \`openssl rand -hex 24\`.`);
  }
  const vaultKey = env[keyEnv] ?? "";
  if (!vaultKey) {
    fail(
      `${keyEnv} is not set. Generate one with \`openssl rand -base64 32\`. ` +
        "There is no plaintext fallback.",
    );
  }

  const dataDir = env.HIVEKIT_DATA ?? "/data";
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    fail(`data dir ${dataDir} is not writable — ${(err as Error).message}`);
  }

  const db = openDb(`${dataDir}/hivekit.db`);

  // Register every secret we hold at the redaction boundary before anything
  // can log it: bootstrap token, vault key; vault entries register on save.
  const redactor = new Redactor();
  redactor.registerMany([bootstrapToken, vaultKey]);

  const vault = new Vault(
    {
      get: (ref) => {
        const row = db.query("SELECT ciphertext FROM vault WHERE ref = ?").get(ref) as
          | { ciphertext: Uint8Array }
          | undefined;
        return row ?? null;
      },
      set: (ref, ct) => {
        db.query(
          "INSERT INTO vault (ref, ciphertext) VALUES (?, ?) ON CONFLICT(ref) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        ).run(ref, ct);
      },
      delete: (ref) => db.query("DELETE FROM vault WHERE ref = ?").run(ref),
    },
    vaultKey,
  );

  const auth = new AuthService(new SqliteAuthStore(db), bootstrapToken);
  const jobs = new JobRunner(db, () => {}); // broadcast wired below
  const gw = createServer({
    db,
    auth,
    jobs,
    redactor,
    publicUrl: cfg.server.public_url,
    port: cfg.server.port,
    webRoot: env.HIVEKIT_WEB_ROOT,
  });

  // Re-wire job broadcasts to the live socket set.
  (jobs as unknown as { broadcast: (e: string, p: unknown) => void }).broadcast =
    gw.broadcast;

  const recovered = jobs.recoverOnBoot();
  if (recovered.resumed > 0) {
    console.log(`[boot] resumed ${recovered.resumed} interrupted job(s) from the run journal`);
  }

  console.log(`[boot] hivekit gateway listening on :${cfg.server.port}`);
  console.log(`[boot] data dir ${dataDir}; threads dir ${cfg.threads_dir}`);

  const shutdown = (sig: string) => {
    console.log(`[shutdown] ${sig} received; closing cleanly`);
    gw.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();