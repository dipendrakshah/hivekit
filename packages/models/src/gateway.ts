/**
 * ModelGateway — the single door every model call goes through (ARCH §4.4).
 * probe -> render-for-capability -> adapter dispatch -> spend (requested vs
 * served). Fallback trips on 429/5xx/timeout only (FR-M5); transit validation
 * belongs to the caller's FR-A6 retry ladder.
 */
import type {
  CapabilityVector,
  CallAttribution,
  Completion,
  CompletionRequest,
  ModelRef,
  ProviderId,
  Delta,
} from "./types";
import { isCrippled } from "./types";
import { probeModel, type ProbeRecord } from "./probe";
import { renderForCapability } from "./render";
import { completeOpenAiCompat } from "./openai";
import { completeAnthropic } from "./anthropic";
import { costUsd, type Catalog } from "./catalog";
import { SpendLogger } from "./spend";

export interface RegisteredProvider {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
}

export interface GatewayOptions {
  registry: (name: string) => RegisteredProvider | null;
  catalog: Catalog;
  spend: SpendLogger;
  capabilityTtlMs: number;
  capabilities?: Map<string, ProbeRecord>;
  fallbackFor?: (model: ModelRef) => ModelRef | null;
  onDelta?: (d: Delta) => void;
  fetchFn?: typeof fetch;
}

const PROBE_ATTR: CallAttribution = { thread_id: "probe", job_id: "probe", task_id: null };

export interface GatewayCallOutcome {
  caps: CapabilityVector;
  rendered: CompletionRequest;
  completion: Completion;
  fallbackUsed: boolean;
  notes: string[];
}

/**
 * Conservative floor used when a probe itself cannot be completed: render as
 * if the model were maximally weak — prepended system, text shim, inlined
 * schema. These lowerings also work fine on FULLY capable models, so this
 * only ever costs bytes, never correctness. Probe outages therefore degrade
 * instead of killing jobs (a probe is infra, not product).
 */
const DEGRADED_CAPS: CapabilityVector = {
  echo: false,
  systemRole: false,
  nativeTools: false,
  jsonMode: false,
  needle8k: false,
  instructionDiscipline: true,
};

export async function gatewayComplete(
  request: CompletionRequest,
  opts: GatewayOptions,
): Promise<GatewayCallOutcome> {
  const notes: string[] = [];
  let caps: CapabilityVector;
  try {
    caps = await capabilityFor(request.model, opts);
  } catch (err) {
    // Probes fail like any other network call; isRetryable here means we got a
    // transient wall — fall back to the conservative floor rather than poison
    // the operator's job. Cache is NOT written, so a healthy next call re-probes.
    if (!isRetryable(err)) throw err;
    caps = DEGRADED_CAPS;
    notes.push(`probe failed (${msg(err)}) — degraded rendering assumed`);
  }
  const rendered = renderForCapability(request, caps);
  if (isCrippled(caps)) notes.push(`weak model ${request.model.id} — shim rendered`);

  let completion: Completion | null = null;
  let fallbackUsed = false;
  try {
    completion = await dispatch(request.model, rendered, opts);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    const fb = opts.fallbackFor?.(request.model);
    if (!fb) throw err;
    // Same degradation safety for the fallback model's capability resolution.
    let fbCaps: CapabilityVector;
    try {
      fbCaps = await capabilityFor(fb, opts);
    } catch (errCap) {
      if (!isRetryable(errCap)) throw errCap;
      fbCaps = DEGRADED_CAPS;
      notes.push(`fallback probe failed — degraded rendering assumed`);
    }
    const fbRendered = renderForCapability({ ...request, model: fb }, fbCaps);
    try {
      completion = await dispatch(fb, fbRendered, opts);
      fallbackUsed = true;
      notes.push(`fell back to ${fb.id}`);
    } catch (err2) {
      throw new Error(`primary ${msg(err)}; fallback ${fb.id}: ${msg(err2)}`);
    }
  }

  const entry = opts.catalog.get(`${request.model.provider}:${request.model.id}`);
  const usd = costUsd(entry, completion.usage.tokensIn, completion.usage.tokensOut);
  opts.spend.record({
    attribution: request.attribution,
    provider: request.model.provider,
    modelRequested: request.model.id,
    served: completion,
    priceInPerM: entry?.priceInPerM ?? null,
    priceOutPerM: entry?.priceOutPerM ?? null,
    usd,
  });

  return { completion, rendered, caps, fallbackUsed, notes };
}

async function capabilityFor(model: ModelRef, opts: GatewayOptions): Promise<CapabilityVector> {
  const map = opts.capabilities ?? new Map<string, ProbeRecord>();
  const outcome = await probeModel(model, PROBE_ATTR, {
    complete: (req) => dispatch(req.model, req, opts),
    models: map,
    ttlMs: opts.capabilityTtlMs,
  });
  return outcome.record.vector;
}

async function dispatch(
  model: ModelRef,
  rendered: CompletionRequest,
  opts: GatewayOptions,
): Promise<Completion> {
  const reg = opts.registry(model.id) ?? opts.registry(model.provider);
  if (!reg) throw new Error(`no key for provider ${model.provider}/${model.id}`);
  const { baseUrl, apiKey } = reg;
  const fetchFn = opts.fetchFn ?? fetch;
  if (reg.provider === "anthropic" || model.provider === "anthropic") {
    return completeAnthropic(rendered, { baseUrl, apiKey, fetchFn }, opts.onDelta);
  }
  return completeOpenAiCompat(rendered, { baseUrl, apiKey, fetchFn }, opts.onDelta);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isRetryable(e: unknown): boolean {
  return /429|5\d\d|rate[ _-]?limit|overload|timeout|abort/i.test(msg(e));
}