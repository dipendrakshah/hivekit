import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { statusTone, type UiApproval } from "@/types";
import { cn } from "@/lib/utils";

/**
 * Approval body — shared by the inline (frozen) thread card and the live
 * approval sheet. DoDs preserved: Deny-first, Approve is never the default
 * focus, decided cards are idempotent-tap safe.
 */
export function ApprovalBody({
  card,
  onDecide,
  frozen,
}: {
  card: UiApproval;
  onDecide: (a: UiApproval, k: "approve" | "deny") => void;
  frozen?: boolean;
}) {
  const pending = !card.decided || card.decided === "pending";
  return (
    <div role="group" aria-label={`Approval required: ${card.title}`} className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{card.title}</span>
        {card.source_flagged && (
          <Badge variant="warn" className="text-[10px]">
            source flagged
          </Badge>
        )}
      </div>
      <div className="font-mono text-[11px] text-muted-foreground">{card.requires_receipt_for}</div>
      {card.diff_preview && (
        <pre tabIndex={0} className="max-h-56 overflow-auto rounded-lg border bg-[#14120e] p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre">
          {card.diff_preview}
        </pre>
      )}
      {Object.keys(card.payload_summary ?? {}).length > 0 && (
        <div className="flex flex-col gap-1 font-mono text-[11px] text-muted-foreground">
          {Object.entries(card.payload_summary).map(([k, v]) => (
            <div key={k}>
              <span className="font-semibold text-foreground">{k}</span> {v}
            </div>
          ))}
        </div>
      )}
      {!frozen && pending && (
        <div className="flex justify-end gap-2">
          {/* Deny first + never autofocused: Approve is never the default focus (a11y DoD). */}
          <Button variant="destructive" size="sm" onClick={() => onDecide(card, "deny")}>
            Deny
          </Button>
          <Button size="sm" onClick={() => onDecide(card, "approve")}>
            Approve
          </Button>
        </div>
      )}
      {frozen && card.decided && card.decided !== "pending" && (
        <div className="font-mono text-[11px]">
          <Badge className={cn(statusTone(card.decided), "text-[10px]")}>{card.decided}</Badge>
        </div>
      )}
    </div>
  );
}
