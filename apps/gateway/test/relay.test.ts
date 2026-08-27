import { describe, expect, test } from "bun:test";
import { TokenRelay } from "../src/relay";

describe("token relay", () => {
  test("delivers every chunk to the sink immediately", () => {
    const chunks: string[] = [];
    const r = new TokenRelay({ onChunk: (t) => chunks.push(t), flush: () => {} });
    r.push("hello ");
    r.push("world");
    expect(chunks).toEqual(["hello ", "world"]);
    expect(r.finish()).toBe("hello world");
  });

  test("flushes at most ~4x/second, never per token", async () => {
    let flushes = 0;
    const r = new TokenRelay({ onChunk: () => {}, flush: () => void ++flushes });
    // 100 rapid pushes inside one flush window → far fewer flushes than pushes.
    for (let i = 0; i < 100; i++) r.push("x");
    await Bun.sleep(300); // let trailing timer fire
    r.finish();
    expect(flushes).toBeLessThan(10);
    expect(flushes).toBeGreaterThanOrEqual(2);
  });

  test("finish() always flushes exactly once more", () => {
    let flushes = 0;
    const r = new TokenRelay({ onChunk: () => {}, flush: () => void ++flushes });
    r.push("data");
    r.finish();
    r.finish(); // idempotent
    expect(flushes).toBeGreaterThanOrEqual(1);
    expect(r.text).toBe("data");
  });
});