import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { short } from "@/types";

export function SettingsView({ master, worker }: { master: string; worker: string }) {
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 md:p-6">
      <h2 className="text-base font-semibold">Settings</h2>
      <Card className="gap-3 py-4">
        <CardHeader>
          <CardTitle className="text-sm">Models</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 font-mono text-xs">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">master</span>
            <span title={master}>{short(master)}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">worker</span>
            <span title={worker}>{short(worker)}</span>
          </div>
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">
        Model swaps and connector credentials write through <code className="font-mono">req.models.set</code> /{" "}
        <code className="font-mono">req.connector.set</code> — those frames land with stream 06. Until then, configure
        providers in <code className="font-mono">config/hivekit.yaml</code> + provider API keys as environment variables (
        <code className="font-mono">OPENROUTER_API_KEY</code>, <code className="font-mono">ANTHROPIC_API_KEY</code>).
        Secrets are never echoed back — by design, there is nothing to echo yet.
      </p>
    </div>
  );
}
