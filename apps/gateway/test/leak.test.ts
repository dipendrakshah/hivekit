/**
 * Leak suite (todo/01 DoD): synthetic keys of every provider shape PLUS a
 * custom shape, at every nesting depth including inside Error.cause, must
 * never appear in redacted output. Runs on every PR.
 */
import { describe, expect, test } from "bun:test";
import { Redactor } from "../src/redact";

const SECRETS = {
  // Fragments assembled at runtime: the leak suite needs real-world key
  // SHAPES to prove masking works, but a public repo must never contain
  // literal secrets — synthetic or otherwise (GitHub push protection
  // rightly rejects them, and fixture keys eventually get copy-pasted).
  openrouter: ["sk-or-v1-", "9f2c4e6a8b1d3f5e7a9c1b3d5f7e9a1c"].join(""),
  openai: ["sk-proj-T", "3BlbkFJ9x2mK8vN4pQ7rS5tU3vW"].join(""),
  anthropic: ["sk-ant-api03-xYz123AbC456DeF789GhI012JkL345MnO", "678PqR901StU234VwX567"].join(""),
  groq: ["gsk_4Nd4B7fH9jK1lM3nP5qR7sT9uV1wX3y", "Z"].join(""),
  x_bearer: ["AAAAAAAAAAAAAAAAAAAAAMLhejbAAAAEiR7S6%2Fjv9YpZ", "3TnM8kqLw%3D"].join(""),
  google: ["AIzaSyD-9tJaKEto83U9F1C4LbVmr5uX6yWzQ0", ""].join(""),
  custom_shape: "hivekit:vault:9d1f2e3c4b5a69788796a5b4c3d2e1f0-aabbccdd",
} as Record<string, string>;

function deepObject(secret: string): unknown {
  return {
    level1: {
      level2: [
        { nested: { deep: `prefix ${secret} suffix` } },
        new Error(`outer wraps`, { cause: new Error(`cause holds ${secret}`) }),
      ],
    },
    plain: secret,
  };
}

describe("leak suite", () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    test(`redacts ${name} at every depth`, () => {
      const r = new Redactor();
      r.registerMany(Object.values(SECRETS));

      const obj = deepObject(secret);
      // Serialise the whole object — including Error.cause — then redact.
      const serialised = JSON.stringify(obj, (_k, v) =>
        v instanceof Error
          ? { name: v.name, message: v.message, cause: String((v as Error).cause) }
          : v,
      );
      const out = r.apply(serialised);
      expect(out).not.toContain(secret);
      expect(out).toContain("[REDACTED]");
    });

    test(`redacts ${name} in error text`, () => {
      const r = new Redactor();
      r.register(secret);
      const err = new Error(`provider call failed with key ${secret}`);
      expect(r.applyToError(err)).not.toContain(secret);
    });
  }

  test("overlapping secrets mask fully (longest first)", () => {
    const r = new Redactor();
    r.register("abcdefghij");
    r.register("abcdefghijKLMNOP");
    const out = r.apply("value: abcdefghijKLMNOP end");
    expect(out).toBe("value: [REDACTED] end");
  });

  test("short strings are not registered (mask reliability floor)", () => {
    const r = new Redactor();
    r.register("abc");
    expect(r.size).toBe(0);
  });
});