/**
 * Config loader — one small YAML plus env overrides (PRD §9).
 *
 * Precedence: env > YAML file > defaults. The file is optional (env-only
 * deployments work); an unknown top-level key is a hard startup error,
 * never a warning — silent config drift is how outages hide.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface RoleModelConfig {
  provider: string;
  model: string;
  fallback?: string;
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
}

export interface HivekitConfig {
  server: { port: number; public_url: string };
  auth: { token_env: string; vault_key_env: string };
  models: {
    master?: RoleModelConfig;
    worker?: RoleModelConfig;
    reviewer: { enabled: boolean };
  };
  threads_dir: string;
  memory: {
    pinned_max_bytes: number;
    rules_top_k: number;
    facts_top_n: number;
    promote_after: number;
    retire_unused_after_runs: number;
    default_fact_ttl_days: number;
    audit_every: number;
    git: boolean;
    diff_in_thread: boolean;
  };
  limits: {
    max_workers_per_job: number;
    max_spawn_depth: 1;
    tool_calls_per_worker: 8;
    job_timeout_minutes: number;
    budget_usd_per_job: number;
    budget_usd_per_day: number;
  };
  policy: {
    mode: "ask" | "auto" | "strict";
    always_ask: string[];
    exec_allowlist: string[];
    stealth_allowed_scopes: string[];
    untrusted_revokes: string[];
  };
  providers: Record<string, { base_url: string }>;
  capability_probe_ttl_days: number;
  connectors: {
    site?: { repo?: string; branch?: string; method?: string };
    x?: { handle?: string };
    email?: { imap_host?: string; smtp_host?: string; folders?: string[] };
  };
  routines_seed: Array<{ name: string; cron: string; prompt: string; notify: string }>;
}

const DEFAULTS: HivekitConfig = {
  server: { port: 8787, public_url: "http://localhost:8787" },
  auth: { token_env: "HIVEKIT_TOKEN", vault_key_env: "HIVEKIT_MASTER_KEY" },
  models: { reviewer: { enabled: false } },
  threads_dir: "/data/threads",
  memory: {
    pinned_max_bytes: 1024,
    rules_top_k: 8,
    facts_top_n: 4,
    promote_after: 3,
    retire_unused_after_runs: 30,
    default_fact_ttl_days: 90,
    audit_every: 20,
    git: false,
    diff_in_thread: true,
  },
  limits: {
    max_workers_per_job: 8,
    max_spawn_depth: 1 as const,
    tool_calls_per_worker: 8 as const,
    job_timeout_minutes: 45,
    budget_usd_per_job: 2.0,
    budget_usd_per_day: 5.0,
  },
  policy: {
    mode: "ask",
    always_ask: ["site.push", "x.post", "email.send", "exec.run"],
    exec_allowlist: ["git status", "git diff"],
    stealth_allowed_scopes: [],
    untrusted_revokes: ["site.push", "x.post", "email.send", "exec.run"],
  },
  providers: {},
  capability_probe_ttl_days: 14,
  connectors: {},
  routines_seed: [],
};

const KNOWN_TOP = new Set([
  "server",
  "auth",
  "models",
  "threads_dir",
  "memory",
  "limits",
  "policy",
  "providers",
  "capability_probe_ttl_days",
  "connectors",
  "routines_seed",
]);

function assertKnownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new Error(`config: unknown key "${k}" in ${where}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HivekitConfig {
  const path = env.HIVEKIT_CONFIG ?? "";
  let fileConfig: Partial<HivekitConfig> = {};
  if (path) {
    const raw = readFileSync(path, "utf8");
    const parsed = parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`config: ${path} must be a YAML mapping`);
    }
    assertKnownKeys(parsed as Record<string, unknown>, KNOWN_TOP, path);
    fileConfig = parsed as Partial<HivekitConfig>;
  }

  // Shallow-merge sections over defaults; env wins last.
  const cfg: HivekitConfig = {
    ...DEFAULTS,
    ...fileConfig,
    server: { ...DEFAULTS.server, ...(fileConfig.server ?? {}) },
    auth: { ...DEFAULTS.auth, ...(fileConfig.auth ?? {}) },
    models: { ...DEFAULTS.models, ...(fileConfig.models ?? {}) },
    memory: { ...DEFAULTS.memory, ...(fileConfig.memory ?? {}) },
    limits: { ...DEFAULTS.limits, ...(fileConfig.limits ?? {}) },
    policy: { ...DEFAULTS.policy, ...(fileConfig.policy ?? {}) },
    providers: { ...DEFAULTS.providers, ...(fileConfig.providers ?? {}) },
    capability_probe_ttl_days: fileConfig.capability_probe_ttl_days ?? 14,
    connectors: { ...DEFAULTS.connectors, ...(fileConfig.connectors ?? {}) },
    routines_seed: fileConfig.routines_seed ?? [],
  };

  cfg.server.port = intEnv(env, "PORT") ?? cfg.server.port;
  if (env.PUBLIC_URL) cfg.server.public_url = env.PUBLIC_URL;

  validate(cfg);
  return cfg;
}

function intEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const v = env[name];
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`config: ${name}="${v}" is not a valid port`);
  }
  return n;
}

function validate(cfg: HivekitConfig): void {
  if (cfg.limits.max_workers_per_job < 1 || cfg.limits.max_workers_per_job > 8) {
    throw new Error("config: limits.max_workers_per_job must be 1..8");
  }
  if (cfg.limits.max_spawn_depth !== 1) {
    throw new Error("config: limits.max_spawn_depth is not configurable above 1");
  }
  if (cfg.limits.tool_calls_per_worker !== 8) {
    throw new Error("config: limits.tool_calls_per_worker is fixed at 8 in v1");
  }
  // The always-ask set is enforced in every mode (FR-S2) — config cannot
  // remove these, in `auto` or otherwise.
  for (const t of ["site.push", "x.post", "email.send"]) {
    if (!cfg.policy.always_ask.includes(t)) {
      throw new Error(`config: policy.always_ask must include "${t}" in every mode`);
    }
  }
}