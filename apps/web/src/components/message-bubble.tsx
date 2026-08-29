import { Badge } from "@/components/ui/badge";
import { statusTone, type UiApproval } from "@/types";
import type { SnapshotMessage } from "@hivekit/protocol";
import { ApprovalBody } from "./approval-card";

export function MessageBubble({ m }: { m: SnapshotMessage }) {
  const isOp = m.role === "op";
  const wireCard = m.card as unknown as { kind?: string; approval_id?: string; title?: string; preview?: string; status?: string } | null;
  const systemCard =
    wireCard?.kind === "approval"
      ? ({
          id: wireCard.approval_id ?? m.id,
          job_id: m.id,
          title: wireCard.title ?? "(approval)",
          payload_summary: {},
          action_kind: "",
          requires_receipt_for: "",
          decided: wireCard.status as UiApproval["decided"],
        } satisfies UiApproval)
      : null;

  return (
    <div className={`flex flex-col ${isOp ? "items-end" : "items-start"}`}>
      <div className="mb-0.5 font-mono text-[11px] text-muted-foreground">{m.role}</div>
      <div
        className={
          isOp
            ? "max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-sm break-words shadow-xs md:max-w-[75%]"
            : m.role === "system"
              ? "max-w-[90%] rounded-2xl border border-dashed bg-[#171512] px-3.5 py-2 text-[13px] break-words shadow-xs md:max-w-[75%]"
              : "max-w-[85%] rounded-2xl rounded-bl-md bg-card px-3.5 py-2 text-sm break-words shadow-xs md:max-w-[75%]"
        }
      >
        {systemCard ? (
          <div className="rounded-lg border p-2.5">
            <ApprovalBody card={systemCard} onDecide={() => {}} frozen />
          </div>
        ) : (
          <p className="whitespace-pre-wrap">{m.body}</p>
        )}
      </div>
    </div>
  );
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge className={`font-mono text-[10px] uppercase tracking-wide ${statusTone(status)} ${className ?? ""}`}>{status}</Badge>
  );
}
