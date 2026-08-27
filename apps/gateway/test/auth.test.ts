import { describe, expect, test } from "bun:test";
import { AuthService, type AuthStore } from "../src/auth";

function memoryAuthStore(): AuthStore & { sessions: Map<string, string> } {
  let passkeyHash: string | null = null;
  const sessions = new Map<string, string>();
  return {
    sessions,
    getPasskeyHash: () => passkeyHash,
    setPasskeyHash: (h) => void (passkeyHash = h),
    insertSession: (hash, exp) => void sessions.set(hash, exp),
    getSession: (hash) =>
      sessions.has(hash) ? { expires_at: sessions.get(hash)! } : null,
    deleteSession: (hash) => void sessions.delete(hash),
  };
}

describe("auth", () => {
  test("bootstrap token logs in while no passkey exists", async () => {
    const store = memoryAuthStore();
    const auth = new AuthService(store, "bootstraptoken1234");
    expect(auth.hasPasskey()).toBe(false);

    // login() is side-effect-free; the HTTP handler orchestrates setup after.
    const res = await auth.login("bootstraptoken1234");
    expect(res).not.toBeNull();
    expect(auth.hasPasskey()).toBe(false);

    // …then the handler calls setupPasskey with the chosen passphrase…
    expect(await auth.setupPasskey("my new owner passphrase")).toBe(true);
    // …and the bootstrap token STILL works afterwards (documented recovery path).
    expect(await auth.login("bootstraptoken1234")).not.toBeNull();
    expect(await auth.login("my new owner passphrase")).not.toBeNull();
  });

  test("passkey set via setup logs in; wrong passphrase does not", async () => {
    const store = memoryAuthStore();
    const auth = new AuthService(store, "");
    expect(await auth.setupPasskey("correct horse battery staple")).toBe(true);

    expect(await auth.login("wrong password entirely")).toBeNull();
    const ok = await auth.login("correct horse battery staple");
    expect(ok).not.toBeNull();
  });

  test("setupPasskey refuses short or duplicate", async () => {
    const store = memoryAuthStore();
    const auth = new AuthService(store, "");
    expect(await auth.setupPasskey("short")).toBe(false);
    await auth.setupPasskey("a valid long passphrase");
    expect(await auth.setupPasskey("another valid passphrase")).toBe(false);
  });

  test("session validates and expires; logout kills it", async () => {
    const store = memoryAuthStore();
    const auth = new AuthService(store, "token-abc-123456");
    const res = (await auth.login("token-abc-123456"))!;
    expect(auth.validateSession(res.token)).toBe(true);
    auth.logout(res.token);
    expect(auth.validateSession(res.token)).toBe(false);
  });

  test("cookie is HttpOnly SameSite=Strict; Secure only when https", async () => {
    const store = memoryAuthStore();
    const insecure = new AuthService(store, "token-abc-123456");
    const r1 = (await insecure.login("token-abc-123456"))!;
    expect(r1.cookie).toContain("HttpOnly");
    expect(r1.cookie).toContain("SameSite=Strict");
    expect(r1.cookie).not.toContain("Secure");

    const secure = new AuthService(memoryAuthStore(), "token-abc-123456");
    const r2 = (await secure.login("token-abc-123456", { secureCookie: true }))!;
    expect(r2.cookie).toContain("Secure");
  });
});