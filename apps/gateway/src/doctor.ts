/**
 * `hivekit doctor` — container-exec health check (todo/01, ARCH §7).
 *
 * Exits 0 on a healthy stack; names the broken check when something is off.
 * Checks: config parse, required env, DB open+writable, disk space, TLS reach.
 * Provider ping / connector auth checks land with streams 03/04.
 */
import { statfsSync } from "node:fs";
import { loadConfig } from "./config";
import { openDb } from "./db";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<number> {
  const checks: Check[] = [];
  const env = process.env;

  // 1. Config parse.
  let cfg;
  try {
    cfg = loadConfig(env);
    checks.push({ name: "config", ok: true, detail: env.HIVEKIT_CONFIG ?? "(defaults)" });
  } catch (err) {
    checks.push({ name: "config", ok: false, detail: (err as Error).message });
    report(checks);
    return 1;
  }

  // 2. Required env vars present.
  for (const [label, name] of [
    ["HIVEKIT_TOKEN", cfg.auth.token_env],
    ["HIVEKIT_MASTER_KEY", cfg.auth.vault_key_env],
  ] as const) {
    const v = env[name];
    checks.push({
      name: label,
      ok: Boolean(v),
      detail: v ? `${name} set (${v.length} chars)` : `${name} is NOT set`,
    });
  }

  // 3. DB opens and accepts writes.
  const dataDir = env.HIVEKIT_DATA ?? "/data";
  try {
    const db = openDb(`${dataDir}/hivekit.db`);
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('doctor_probe', ?)").run(
      new Date().toISOString(),
    );
    db.close();
    checks.push({ name: "database", ok: true, detail: `${dataDir}/hivekit.db writable` });
  } catch (err) {
    checks.push({ name: "database", ok: false, detail: (err as Error).message });
  }

  // 4. Disk headroom on the data volume.
  try {
    const st = statfsSync(dataDir);
    const freeGb = (Number(st.bavail) * Number(st.bsize)) / 1e9;
    checks.push({
      name: "disk",
      ok: freeGb >= 0.5,
      detail: `${freeGb.toFixed(2)} GB free on ${dataDir}`,
    });
  } catch (err) {
    checks.push({ name: "disk", ok: false, detail: (err as Error).message });
  }

  // 5. Public URL reachable over TLS when https.
  if (cfg.server.public_url.startsWith("https://")) {
    try {
      const res = await fetch(cfg.server.public_url.replace(/\/$/, "") + "/healthz", {
        signal: AbortSignal.timeout(5000),
      });
      checks.push({
        name: "tls",
        ok: res.ok,
        detail: `${cfg.server.public_url}/healthz → ${res.status}`,
      });
    } catch (err) {
      checks.push({ name: "tls", ok: false, detail: (err as Error).message });
    }
  } else {
    checks.push({
      name: "tls",
      ok: true,
      detail: `public_url is ${cfg.server.public_url} (no TLS check)`,
    });
  }

  report(checks);
  return checks.every((c) => c.ok) ? 0 : 1;
}

function report(checks: Check[]): void {
  console.log("hivekit doctor");
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(10)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed: ${failed.map((c) => c.name).join(", ")}`);
  } else {
    console.log("\nall checks passed");
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`doctor crashed: ${(err as Error).message}`);
    process.exit(1);
  },
);