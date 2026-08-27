/**
 * Auth — single operator (ARCH §4.7, PRD FR-C3).
 *
 * "Passkey" means an Argon2id-hashed PASSPHRASE via Bun.password — never
 * WebAuthn in v1. First login sets it; later logins verify against the hash.
 * HIVEKIT_TOKEN is the bootstrap/recovery path: valid only while no passkey
 * exists (or when explicitly used for recovery), and never stored.
 *
 * Sessions are random 256-bit tokens; the DB stores SHA-256(token) so a DB
 * leak cannot be replayed as a session. Cookie is HttpOnly + SameSite=Strict,
 * Secure whenever PUBLIC_URL is https.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

export interface AuthStore {
  getPasskeyHash(): string | null;
  setPasskeyHash(hash: string): void;
  insertSession(tokenHash: string, expiresAt: string): void;
  getSession(tokenHash: string): { expires_at: string } | null;
  deleteSession(tokenHash: string): void;
}

export class SqliteAuthStore implements AuthStore {
  constructor(private readonly db: Database) {}

  getPasskeyHash(): string | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = 'owner_passkey_hash'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setPasskeyHash(hash: string): void {
    this.db
      .query("INSERT INTO settings (key, value) VALUES ('owner_passkey_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(hash);
  }

  insertSession(tokenHash: string, expiresAt: string): void {
    this.db
      .query("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)")
      .run(tokenHash, expiresAt);
  }

  getSession(tokenHash: string): { expires_at: string } | null {
    return (
      (this.db.query("SELECT expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as {
        expires_at: string;
      } | null) ?? null
    );
  }

  deleteSession(tokenHash: string): void {
    this.db.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn a compare to keep timing flat.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export class AuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly bootstrapToken: string,
  ) {}

  hasPasskey(): boolean {
    return this.store.getPasskeyHash() !== null;
  }

  /** First login sets the passkey. Refuses if one already exists. */
  async setupPasskey(passphrase: string): Promise<boolean> {
    if (!passphrase || passphrase.length < 8) return false;
    if (this.hasPasskey()) return false;
    const hash = await Bun.password.hash(passphrase, {
      algorithm: "argon2id",
      memoryCost: 19456, // OWASP 2024 baseline: 19 MiB
      timeCost: 2,
    });
    this.store.setPasskeyHash(hash);
    return true;
  }

  /**
   * Login. Order of checks:
   *  1. passkey match → session
   *  2. no passkey yet + bootstrap token match → session (setup mode)
   *  3. recovery: token matches even with a passkey (documented loss path)
   */
  async login(
    passphraseOrToken: string,
    opts: { secureCookie?: boolean } = {},
  ): Promise<{ cookie: string; token: string } | null> {
    let ok = false;

    const hash = this.store.getPasskeyHash();
    if (hash && passphraseOrToken.length >= 8) {
      ok = await Bun.password.verify(passphraseOrToken, hash);
    }
    if (!ok && this.bootstrapToken.length > 0) {
      ok = constantTimeEqual(passphraseOrToken, this.bootstrapToken);
    }
    if (!ok) return null;

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    this.store.insertSession(hashToken(token), expiresAt);
    return {
      cookie: serializeCookie(token, expiresAt, opts.secureCookie ?? false),
      token,
    };
  }

  /** Constant-time-ish session check for every WS upgrade and API call. */
  validateSession(token: string): boolean {
    if (!token) return false;
    const row = this.store.getSession(hashToken(token));
    if (!row) return false;
    return new Date(row.expires_at).getTime() > Date.now();
  }

  logout(token: string): void {
    this.store.deleteSession(hashToken(token));
  }
}

export function serializeCookie(token: string, expiresAtIso: string, secure = false): string {
  const parts = [
    `hk_session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Expires=${new Date(expiresAtIso).toUTCString()}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function parseCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "hk_session") return rest.join("=");
  }
  return null;
}