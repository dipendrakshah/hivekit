import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hivekit-cfg-"));

describe("config loader", () => {
  test("defaults apply when no file is given", () => {
    const cfg = loadConfig({});
    expect(cfg.server.port).toBe(8787);
    expect(cfg.policy.mode).toBe("ask");
    expect(cfg.limits.max_workers_per_job).toBe(8);
  });

  test("unknown top-level key fails startup loudly", () => {
    const p = join(dir, "bad.yaml");
    writeFileSync(p, "server:\n  port: 9000\nscret_option: oops\n");
    expect(() => loadConfig({ HIVEKIT_CONFIG: p })).toThrow(/unknown key "scret_option"/);
  });

  test("example config parses and validates", () => {
    const p = join(dir, "ok.yaml");
    writeFileSync(
      p,
      [
        "server:",
        "  port: 9999",
        "limits:",
        "  max_workers_per_job: 4",
        "policy:",
        "  always_ask: [site.push, x.post, email.send]",
      ].join("\n"),
    );
    const cfg = loadConfig({ HIVEKIT_CONFIG: p });
    expect(cfg.server.port).toBe(9999);
    expect(cfg.limits.max_workers_per_job).toBe(4);
  });

  test("always_ask cannot drop protected tools", () => {
    const p = join(dir, "evil.yaml");
    writeFileSync(p, "policy:\n  always_ask: []\n");
    expect(() => loadConfig({ HIVEKIT_CONFIG: p })).toThrow(/must include "site\.push"/);
  });

  test("PORT env overrides file", () => {
    const cfg = loadConfig({ PORT: "7000" });
    expect(cfg.server.port).toBe(7000);
  });

  test("invalid PORT fails clearly", () => {
    expect(() => loadConfig({ PORT: "notaport" })).toThrow(/not a valid port/);
  });
});