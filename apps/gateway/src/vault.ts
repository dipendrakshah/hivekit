/**
 * Vault — AES-256-GCM at rest, key from HIVEKIT_MASTER_KEY env (ARCH §4.7).
 *
 * A missing or short key is a hard startup error — never a silent plaintext
 * fallback. Ciphertext layout: [12-byte nonce][tag+ciphertext]. Values are
 * never returned to clients after save; the gateway dereferences them only
 * inside tool executors.
 */
import { createHash, webcrypto } from "node:crypto";

const NONCE_BYTES = 12;

export class VaultKeyError extends Error {}

function toKeyBytes(secret: string): Uint8Array<ArrayBuffer> {
  const digest = createHash("sha256").update(secret).digest();
  const out = new Uint8Array(digest.byteLength);
  out.set(digest);
  return out;
}

export class Vault {
  #key: CryptoKey | null = null;
  readonly #rawSecret: string;

  constructor(
    private readonly db: {
      get: (ref: string) => { ciphertext: Uint8Array } | null;
      set: (ref: string, ciphertext: Uint8Array) => void;
      delete: (ref: string) => void;
    },
    secret: string,
  ) {
    if (!secret || secret.length < 16) {
      throw new VaultKeyError(
        "vault: HIVEKIT_MASTER_KEY is missing or shorter than 16 chars — refusing to start. " +
          "Generate one with `openssl rand -base64 32`. There is no plaintext fallback.",
      );
    }
    this.#rawSecret = secret;
  }

  /** Lazy so a Vault can be constructed before first async use. */
  async #getKey(): Promise<CryptoKey> {
    if (!this.#key) {
      this.#key = await webcrypto.subtle.importKey(
        "raw",
        toKeyBytes(this.#rawSecret),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
    }
    return this.#key;
  }

  async set(ref: string, plaintext: string): Promise<void> {
    const key = await this.#getKey();
    const nonce = webcrypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const pt = new TextEncoder().encode(plaintext) as Uint8Array<ArrayBuffer>;
    const ct = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, pt);
    // WebCrypto GCM appends its 16-byte auth tag to the ciphertext bytes.
    const blob = new Uint8Array(NONCE_BYTES + ct.byteLength);
    blob.set(nonce, 0);
    blob.set(new Uint8Array(ct), NONCE_BYTES);
    this.db.set(ref, blob);
  }

  /**
   * Returns null when the ref does not exist OR fails to authenticate
   * (wrong key / corrupted row) — callers already handle absence, and a
   * wrong-key read must not crash the gateway.
   */
  async get(ref: string): Promise<string | null> {
    const row = this.db.get(ref);
    if (!row) return null;
    const key = await this.#getKey();
    const raw = row.ciphertext;
    const nonce = raw.slice(0, NONCE_BYTES);
    const body = raw.slice(NONCE_BYTES);
    try {
      const clear = await webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as unknown as Uint8Array<ArrayBuffer> },
        key,
        body,
      );
      return new TextDecoder().decode(clear);
    } catch {
      return null;
    }
  }

  delete(ref: string): void {
    this.db.delete(ref);
  }

  has(ref: string): boolean {
    return this.db.get(ref) !== null;
  }
}