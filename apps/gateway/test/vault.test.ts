import { describe, expect, test } from "bun:test";
import { Vault, VaultKeyError } from "../src/vault";

function memoryVaultStore() {
  const rows = new Map<string, Uint8Array>();
  return {
    get: (ref: string) => (rows.has(ref) ? { ciphertext: rows.get(ref)! } : null),
    set: (ref: string, ct: Uint8Array) => void rows.set(ref, ct),
    delete: (ref: string) => void rows.delete(ref),
  };
}

describe("vault", () => {
  test("round-trips a secret", async () => {
    const v = new Vault(memoryVaultStore(), "test-master-key-0123456789");
    await v.set("openrouter", "sk-or-v1-abcdef0123456789");
    expect(await v.get("openrouter")).toBe("sk-or-v1-abcdef0123456789");
  });

  test("ciphertext at rest is not plaintext", async () => {
    const store = memoryVaultStore();
    const v = new Vault(store, "test-master-key-0123456789");
    const secret = "sk-or-v1-supersecret-value";
    await v.set("openrouter", secret);
    const stored = store.get("openrouter")!.ciphertext;
    expect(Buffer.from(stored).toString("latin1")).not.toContain(secret);
  });

  test("missing key refuses to construct — no plaintext fallback", () => {
    expect(() => new Vault(memoryVaultStore(), "")).toThrow(VaultKeyError);
    expect(() => new Vault(memoryVaultStore(), "short")).toThrow(VaultKeyError);
  });

  test("wrong key fails to decrypt", async () => {
    const store = memoryVaultStore();
    const v1 = new Vault(store, "correct-key-0123456789");
    await v1.set("x", "payload");
    const v2 = new Vault(store, "different-key-0123456789");
    expect(await v2.get("x")).toBe(null);
  });

  test("delete removes the entry", async () => {
    const v = new Vault(memoryVaultStore(), "test-master-key-0123456789");
    await v.set("tmp", "value");
    expect(v.has("tmp")).toBe(true);
    v.delete("tmp");
    expect(v.has("tmp")).toBe(false);
  });
});