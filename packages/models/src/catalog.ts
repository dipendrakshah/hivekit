/**
 * Catalog cache (§4.4) — first use of a provider exposing /models stores
 * id/context/price/modality; Settings reads it; raw slugs are always allowed.
 * Stealth/free models are first-class with `price: 0` and a flag so the UI
 * can show the retention banner for sensitive scopes.
 */
import type { ProviderId } from "./types";

export interface CatalogEntry {
  provider: ProviderId;
  id: string;
  context: number | null;
  priceInPerM: number | null; // USD per 1M input tokens, null = unknown
  priceOutPerM: number | null;
  modality: string | null;
  stealth: boolean; // anonymous/free route that may retain prompts
}

export type Catalog = Map<string, CatalogEntry>; // key = `${provider}:${id}`

export function catalogKey(provider: ProviderId, id: string): string {
  return `${provider}:${id}`;
}

/** Cost of one completion, in USD. Missing prices fall back to a heuristic. */
export function costUsd(
  entry: CatalogEntry | undefined,
  tokensIn: number,
  tokensOut: number,
): number {
  if (entry?.priceInPerM && entry.priceOutPerM) {
    return (tokensIn / 1e6) * entry.priceInPerM + (tokensOut / 1e6) * entry.priceOutPerM;
  }
  return ((tokensIn + tokensOut) / 1e6) * 1.0; // unknown-price estimate
}

/** Parse an OpenRouter-style /models payload into catalog entries. */
export function parseCatalog(provider: ProviderId, payload: { data?: Array<Record<string, unknown>> }): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const m of payload.data ?? []) {
    const id = typeof m.id === "string" ? m.id : null;
    if (!id) continue;
    const pricing = (m.pricing as { prompt?: string; completion?: string } | undefined) ?? {};
    const priceIn = parsePrice(pricing.prompt);
    const priceOut = parsePrice(pricing.completion);
    out.push({
      provider,
      id,
      context: typeof m.context_length === "number" ? m.context_length : null,
      priceInPerM: priceIn,
      priceOutPerM: priceOut,
      modality: typeof m.modalities === "object" ? JSON.stringify(m.modalities) : null,
      stealth: (priceIn === 0 && priceOut === 0) || /stealth|free/i.test(id),
    });
  }
  return out;
}

function parsePrice(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}