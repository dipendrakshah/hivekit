/**
 * Client-side approval shape — assembled from event.approval frames.
 * (The wire card lives in @hivekit/protocol; this carries UI-only decision state.)
 */
export interface UiApproval {
  id: string;
  job_id: string;
  title: string;
  diff_preview?: string;
  payload_summary: Record<string, string>;
  action_kind: string;
  requires_receipt_for: string;
  source_flagged?: boolean;
  decided?: "approved" | "denied" | "pending";
}

/** Map a wire status → Badge styling. One place, so pills never drift. */
export function statusTone(status: string): string {
  if (["done", "ok", "enabled", "approved"].includes(status)) return "bg-[#1c241c] text-sage border-transparent";
  if (["failed", "cancelled", "denied"].includes(status)) return "bg-destructive/15 text-destructive border-transparent";
  if (["blocked", "needs_approval", "warn", "pending"].includes(status)) return "bg-[#2a2110] text-warn border-transparent";
  // running / planning / merging / queued …
  return "bg-[#2a2314] text-primary border-transparent";
}

export function short(modelId: string): string {
  if (modelId.length <= 22) return modelId;
  return `${modelId.slice(0, 10)}…${modelId.slice(-8)}`;
}
