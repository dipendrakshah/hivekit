import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "./message-bubble";
import type { Snapshot } from "@hivekit/protocol";

export function RoutinesView({ snapshot }: { snapshot: Snapshot | null }) {
  const routines = snapshot?.routines ?? [];
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 md:p-6">
      <div>
        <h2 className="text-base font-semibold">Routines</h2>
        <p className="font-mono text-[11px] text-muted-foreground">recurring chores on cron</p>
      </div>
      {routines.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No routines yet. Create them from chat ("every morning at 07:00 …") once routine frames land.
        </p>
      )}
      {routines.map((r) => {
        const next = r.next_run_at ? new Date(r.next_run_at) : null;
        const mins = next ? Math.max(0, Math.round((next.getTime() - Date.now()) / 60000)) : null;
        return (
          <Card key={r.id} className="gap-3 py-4">
            <CardHeader>
              <CardTitle className="text-sm">{r.name}</CardTitle>
              <CardDescription className="font-mono text-[11px]">
                cron {r.cron} · notify {r.notify}
              </CardDescription>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px]">{mins !== null ? `next run in ${mins}m` : "no run scheduled"}</span>
                <StatusBadge status={r.enabled ? "enabled" : "cancelled"} className={r.enabled ? "" : "text-destructive bg-destructive/15"} />
              </div>
            </CardHeader>
          </Card>
        );
      })}
      <p className="font-mono text-[11px] text-muted-foreground">pause/resume/edit arrives with routine CRUD frames (stream 06).</p>
    </div>
  );
}
