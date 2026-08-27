/**
 * FR-A6 code-first validation ladder (§4.4.2, todo/03).
 *
 * Validation is CODE (schema → required fields → success sentence) — never a
 * model judging another model. When validation fails:
 *
 *   strike 1 → same model, the EXACT validator error appended verbatim
 *   strike 2 → same model + tighter spec (validator's tightenedInput if it has one)
 *   strike 3 → fallback model carrying the full failure transcript
 *   exhausted → onExhausted → gateway renders a question card
 *
 * The exact-error contract is measurable: todo/03 DoD demands evidence that
 * second-attempt success is HIGHER with the error appended than without, so
 * every attempt is recorded for that comparison.
 */
import type { CompletionRequest } from "./types";

export interface Attempt {
  n: number;
  arm: "same" | "same-tighter" | "fallback";
  /** Verbatim prompt suffix this attempt SAW (empty for attempt 1). */
  sawSuffix: string;
  ok: boolean;
  error?: string;
}

export interface ValidatorResult<I> {
  ok: boolean;
  error?: string;
  /** Strike-2 structural tightening: fewer/renamed inputs. Optional. */
  tightenedInput?: I;
}

export type Validator<I> = (value: I) => ValidatorResult<I>;

export interface LadderFailure {
  error: string;
  suffix: string;
  tightenedInput?: unknown;
}

export interface LadderDeps<I> {
  baseRequest: CompletionRequest;
  /** Builds attempt N; arms fall back internally when a fallback exists. */
  buildAttempt: (
    n: number,
    arm: "same" | "same-tighter" | "fallback",
    failures: LadderFailure[],
    tightenedInput?: unknown,
  ) => { request: CompletionRequest; input: unknown };
  call: (req: CompletionRequest, input: unknown) => Promise<{ value: I; raw: string }>;
  validate: Validator<I>;
  fallbackFor?: () => CompletionRequest | null;
  onExhausted?: (attempts: Attempt[]) => void;
}

export interface LadderOutcome<I> {
  value?: I;
  raw?: string;
  attempts: Attempt[];
  succeededOnArm?: Attempt["arm"];
}

export function validationMarker(kind: string, body: string): string {
  return `<validation-result kind="${kind}">\n${body}\n</validation-result>`;
}

const ARMS: Array<"same" | "same-tighter" | "fallback"> = ["same", "same-tighter", "fallback"];

export async function runLadder<I>(deps: LadderDeps<I>): Promise<LadderOutcome<I>> {
  const arms = deps.fallbackFor ? ARMS : (ARMS.filter((a) => a !== "fallback") as typeof ARMS);
  const attempts: Attempt[] = [];
  const failures: LadderFailure[] = [];

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i]!;
    const priorTightened = failures.at(-1)?.tightenedInput;
    const built = deps.buildAttempt(i, arm, failures, arm === "same-tighter" ? priorTightened : undefined);
    let req = built.request;

    // Strike ≥2 freezes temperature; strike 3 swaps in the fallback model but
    // keeps the operator's task input identical — the MODEL is the variable,
    // never silently the assignment.
    if (arm !== "same") req = { ...req, temperature: Math.min(req.temperature ?? 0.2, 0) };
    if (arm === "fallback" && deps.fallbackFor) req = deps.fallbackFor() ?? req;

    try {
      const { value, raw } = await deps.call(req, built.input);
      const verdict = deps.validate(value);
      attempts.push({
        n: i + 1,
        arm,
        sawSuffix: failures.at(-1)?.suffix ?? "",
        ok: verdict.ok,
        error: verdict.error,
      });
      if (verdict.ok) return { value, raw, attempts, succeededOnArm: arm };

      failures.push({
        error: verdict.error ?? "invalid result",
        suffix: validationMarker("failed-validation", verdict.error ?? "invalid result"),
        ...(verdict.tightenedInput !== undefined ? { tightenedInput: verdict.tightenedInput } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ error: message, suffix: validationMarker("attempt-error", message) });
      attempts.push({ n: i + 1, arm, sawSuffix: failures.at(-1)!.suffix, ok: false, error: message });
    }
  }

  deps.onExhausted?.(attempts);
  return { attempts };
}
