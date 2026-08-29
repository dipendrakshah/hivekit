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
import { MasterRuntime } from "./runtime";
import { compilePolicy } from "./policy";
import type { Catalog } from "@hivekit/models";
import { ThreadWorkspace } from "./workspace";
import { createServer } from "./server";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

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
  const jobs = new JobRunner(db);

  // --- Master runtime (stream 03). Optional: boots API-only without keys.
  const providers = cfg.providers as Record<string, { base_url: string }>;
  const apiKeyFor = (provider: string): string | null => {
    const envName = `${provider.toUpperCase()}_API_KEY`;
    // "zai" is the configured provider name for Z.ai; accept both spellings.
    const aliases: Record<string, string> = { Z_AI_API_KEY: "ZAI_API_KEY", GLM_API_KEY: "ZAI_API_KEY" };
    return env[envName] ?? (aliases[envName] ? env[aliases[envName]] : null) ?? null;
  };
  // Zero-config boot: no models in the config file? Derive them from whichever
  // provider key exists in the environment. One key = a thinking hive.
  const envModels = (() => {
    if (cfg.models.master || cfg.models.worker) return null;
    const candidates: Array<{ provider: string; model: string }> = [
      { provider: "zai", model: "glm-5.3-flash" },
      { provider: "openrouter", model: "openrouter/auto" },
      { provider: "anthropic", model: "claude-sonnet-4-5" },
    ];
    const first = candidates.find((c) => apiKeyFor(c.provider));
    if (!first) return null;
    // The base_url map comes from config; with no config file, synthesize the
    // registry entry for whichever provider we just derived models from.
    const KNOWN_BASE: Record<string, string> = {
      zai: "https://api.z.ai/api/paas/v4",
      openrouter: "https://openrouter.ai/api/v1",
      anthropic: "https://api.anthropic.com/v1",
    };
    providers[first.provider] = { base_url: KNOWN_BASE[first.provider]! };
    console.log(`[boot] no models in config — deriving master+worker from ${first.provider} key`);
    const withFallback = { ...first, fallback: undefined as string | undefined };
    return { master: withFallback, worker: withFallback };
  })();

  // One-key boot: if the master's provider has no key but the worker's does,
  // the master runs on the worker's provider — a hive with one key still thinks.
  const masterCfg = cfg.models.master ?? envModels?.master;
  const workerCfg = cfg.models.worker ?? envModels?.worker;
  const masterKey = masterCfg ? apiKeyFor(masterCfg.provider) : null;
  const workerKey = workerCfg ? apiKeyFor(workerCfg.provider) : null;
  const effectiveMaster = masterCfg && masterKey ? masterCfg : workerCfg;
  if (effectiveMaster !== masterCfg && effectiveMaster)
    console.log("[boot] no key for master provider — master riding the worker's provider");
  const hasModels = Boolean(effectiveMaster && workerCfg && (masterKey || workerKey));
  const catalog: Catalog = new Map();
  const threadsDir = cfg.threads_dir === "/data/threads" && env.HIVEKIT_DATA
    ? `${env.HIVEKIT_DATA}/threads`
    : cfg.threads_dir;

  let runtime: MasterRuntime | undefined;
  if (hasModels) {
    runtime = new MasterRuntime({
      db,
      threadsDir,
      models: {
        master: { provider: effectiveMaster!.provider as never, model: effectiveMaster!.model, fallback: effectiveMaster!.fallback },
        worker: { provider: workerCfg!.provider as never, model: workerCfg!.model, fallback: workerCfg!.fallback },
      },
      providers,
      apiKeyFor,
      catalog,
      limits: cfg.limits,
      capabilityTtlMs: (cfg.capability_probe_ttl_days ?? 14) * 86_400_000,
      policyOverrides: compilePolicy({
        mode: cfg.policy.mode,
        always_ask: cfg.policy.always_ask,
        exec_allowlist: cfg.policy.exec_allowlist,
      }).overrides,
      broadcast: () => {}, // re-wired below via runtime.setBroadcaster, same pattern as jobs
      memoryBlockFor: (threadId) => {
        try {
          const slug = db.query("SELECT slug FROM threads WHERE id = ?").get(threadId) as { slug: string } | undefined;
          if (!slug) return "";
          const { MemoryStore, assemble, recordRetrievals } = require("@hivekit/memory") as typeof import("@hivekit/memory");
          const store = new MemoryStore(`${threadsDir}/${slug.slug}`, cfg.memory);
          const a = assemble(store.load(), { scope: {}, jobId: "prompt", run: 0 }, store.config());
          recordRetrievals(store, a, { scope: {}, jobId: "prompt", run: 0 });
          return a.promptBlock;
        } catch { return ""; }
      },
      instructionsFor: (threadId) => {
        try {
          const slug = db.query("SELECT slug FROM threads WHERE id = ?").get(threadId) as { slug: string } | undefined;
          if (!slug) return "";
          return new ThreadWorkspace(threadsDir, slug.slug).readInstructions();
        } catch { return ""; }
      },
      onDelta: () => {}, // re-wired below via runtime.setOnDelta, straight to event.thread.delta
      fetchFn: undefined,
    });
    void apiKeyFor; void hasModels;
  }

  const gw = createServer({
    db,
    auth,
    jobs,
    runtime,
    redactor,
    publicUrl: cfg.server.public_url,
    port: cfg.server.port,
    // Serve the built UI by default (container: /app/dist/web). An explicit
    // HIVEKIT_WEB_ROOT overrides; missing dir → API-only, same as before.
    webRoot:
      env.HIVEKIT_WEB_ROOT ??
      (existsSync(join(dirname(import.meta.path), "web", "index.html"))
        ? join(dirname(import.meta.path), "web")
        : undefined),
  });

  // Broadcast to the live socket set — set explicitly, no private-field cast.
  jobs.setBroadcaster(gw.broadcast);
  if (runtime) {
    runtime.setBroadcaster(gw.broadcast);
    // Live-typing effect only; the authoritative row lands via insertSystem's
    // own broadcast once text is final — this never touches message storage.
    runtime.setOnDelta((threadId, text) => gw.broadcast("event.thread.delta", { thread_id: threadId, delta: text }));
  }

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