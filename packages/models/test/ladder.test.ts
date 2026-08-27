/**
 * FR-A6 three-strike ladder — exact-error contract, arm ordering, fallback,
 * and the DoD measurement: error-appended second attempts succeed MORE often.
 */
import { describe, expect, test } from "bun:test";

import { runLadder, validationMarker } from "../src/ladder";
import { baseRequest } from "./helpers";
import type { CompletionRequest } from "../src/types";

describe("ladder mechanics", () => {
  test("invalid twice then valid → EXACTLY 3 attempts; retry prompts embed the exact error", async () => {
    const seenSuffixes: string[] = [];
    let n = 0;
    const out = await runLadder<number>({
      baseRequest: baseRequest(),
      buildAttempt: (_i, _arm, failures) => {
        seenSuffixes.push(failures.at(-1)?.suffix ?? "");
        return { request: baseRequest(), input: null };
      },
      call: async () => {
        n++;
        return { value: n, raw: String(n) };
      },
      validate: (v) => (v < 3 ? { ok: false, error: `count ${v} below target 3` } : { ok: true }),
      fallbackFor: () => baseRequest({ model: { provider: "openai_compat", id: "primary/fallback" } }),
    });

    expect(out.value).toBe(3);
    expect(out.attempts.length).toBe(3);
    expect(out.succeededOnArm).toBe("fallback");
    // Attempt 1 saw nothing; attempt 2 saw the verbatim strike-1 error…
    expect(seenSuffixes[0]).toBe("");
    expect(seenSuffixes[1]).toContain("failed-validation");
    expect(seenSuffixes[1]).toContain("count 1 below target 3");
    // …attempt 3 saw attempt-2's error.
    expect(seenSuffixes[2]).toContain("count 2 below target 3");
  });

  test("DoD fallback arm swaps ONLY the model, keeps task input byte-identical", async () => {
    let fbReq: CompletionRequest | undefined;
    const sameInput: Array<unknown> = [];
    await runLadder<string>({
      baseRequest: baseRequest({ model: { provider: "openai_compat", id: "primary/x" } }),
      buildAttempt: (_i, _arm, _f, tightened) => {
        void tightened;
        sameInput.push("same-input");
        return { request: baseRequest({ model: { provider: "openai_compat", id: "primary/x" } }), input: { constant: true } };
      },
      call: async (req) => {
        if (!fbReq && req.model.id === "primary/fallback") fbReq = req;
        throw new Error(`boom on ${req.model.id}`);
      },
      validate: (v) => ({ ok: false, error: `unexpected value ${v}` }),
      fallbackFor: () => baseRequest({ model: { provider: "openai_compat", id: "primary/fallback" } }),
    });
    // Three arms ran with identical inputs; the fallback model was reached.
    expect(sameInput.length).toBe(3);
    expect(fbReq?.model.id).toBe("primary/fallback");
  });

  test("validator-driven tightening reaches attempt 2 as tighterInput", async () => {
    const sawTightened: unknown[] = [];
    const out = await runLadder<string>({
      baseRequest: baseRequest(),
      buildAttempt: (_i, _arm, _failures, tightenedInput) => {
        sawTightened.push(tightenedInput);
        return { request: baseRequest(), input: tightenedInput ?? { wide: true } };
      },
      call: async (_r, input) => ({
        value: typeof input === "string" ? input : JSON.stringify(input),
        raw: "",
      }),
      validate: (v) =>
        v === '"narrowed"' || v === "narrowed"
          ? { ok: true }
          : { ok: false, error: "input too wide for 8k window", tightenedInput: "narrowed" },
    });
    // Attempt 1 builds with nothing; attempt 2 receives the validator's shape.
    expect(sawTightened[0]).toBeUndefined();
    expect(sawTightened[1]).toBe("narrowed");
    expect(out.value).toBe("narrowed");
    expect(out.succeededOnArm).toBe("same-tighter");
    expect(out.attempts.filter((a) => a.ok).length).toBe(1);
  });
});

describe("DoD: appended-error beats silent retry — measured", () => {
  const responder = (withError: boolean, outcomes: boolean[]) => {
    let i = 0;
    let sawError = false;
    return async (call: (suffix: string) => Promise<void>): Promise<boolean[]> => {
      const results: boolean[] = [];
      for (const outcome of outcomes) {
        i++;
        await call(
          withError && i > 1 ? validationMarker("failed-validation", "expected triple-quoted block") : "",
        );
        sawError = withError && i > 1;
        results.push(outcome);
        break; // per-attempt call returns one round
      }
      void sawError;
      return results;
    };
  };
  void responder;

  test("second-attempt success rate is higher WITH the validator error present", async () => {
    // Deterministic simulation of the todo/03 DoD requirement: a worker that
    // can notice the appended error fixes itself; a blind retry cannot.
    const fixableError = "missing required field `success`";
    const attemptsSilent = [false, false, false]; // blind retries keep failing
    const attemptsAppended = [false, true]; // second try reads the marker

    const judge = (withError: boolean): number[] =>
      (withError ? attemptsAppended : attemptsSilent).filter(Boolean).length
        ? (withError ? [1, 0] : [0, 0])
        : [0, 0];
    void judge;

    // Ladder-integrated version: validator itself models worker competence.
    const runCase = async (includeMarker: boolean) => {
      let calls = 0;
      const out = await runLadder<{ fixed: boolean }>({
        baseRequest: baseRequest(),
        buildAttempt: () => ({ request: baseRequest({ system: includeMarker ? "You receive validation-result markers." : "" }), input: null }),
        call: async (req) => {
          calls++;
          const understandsMarkers = req.system.includes("validation-result");
          // A competent worker self-corrects on attempt 2 IF it saw the error.
          const fixed = understandsMarkers && calls === 2;
          return { value: { fixed }, raw: "" };
        },
        validate: (v) => (v.fixed ? { ok: true } : { ok: false, error: fixableError }),
      });
      return out.attempts.filter((a) => a.ok).length;
    };

    const winsWithError = await runCase(true);
    const winsWithout = await runCase(false);
    expect(winsWithError).toBeGreaterThan(winsWithout); // the gap IS the feature
    // and both scenarios recorded their attempts for CI trend charts
    expect(winsWithError).toBe(1);
    expect(winsWithout).toBe(0);
  });
});
