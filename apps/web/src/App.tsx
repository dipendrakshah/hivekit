/**
 * Hivekit web app — the only client (todo/05).
 *
 * Desktop: nav rail + thread + status rail. Phone (<md): bottom tabs.
 * Live over WS; on reconnect the client re-hellos and the snapshot REPLACES
 * local state — catch-up is structural, no event replay needed.
 *
 * UI: React + Tailwind v4 + shadcn/ui primitives; TanStack Query owns the
 * auth HTTP state; TanStack Table renders the receipts jobs grid.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Clock, MessageSquare, Plus, ReceiptText, Settings } from "lucide-react";

import type { Snapshot, SnapshotJob } from "@hivekit/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ApprovalBody } from "@/components/approval-card";
import { ChatView } from "@/components/chat-view";
import { RoutinesView } from "@/components/routines-view";
import { ReceiptsView } from "@/components/receipts-view";
import { SettingsView } from "@/components/settings-view";
import { short, type UiApproval } from "@/types";
import { cn } from "@/lib/utils";

type ConnState = "connecting" | "open" | "closed";
type Tab = "threads" | "routines" | "receipts" | "settings";

const TABS: { id: Tab; label: string; icon: typeof MessageSquare }[] = [
  { id: "threads", label: "Threads", icon: MessageSquare },
  { id: "routines", label: "Routines", icon: Clock },
  { id: "receipts", label: "Receipts", icon: ReceiptText },
  { id: "settings", label: "Settings", icon: Settings },
];

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [conn, setConn] = useState<ConnState>("connecting");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [streamText, setStreamText] = useState("");
  const [streamingJobId, setStreamingJobId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("threads");
  const [approvals, setApprovals] = useState<UiApproval[]>([]);
  const [dismissedSheets, setDismissedSheets] = useState<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);

  // ---- auth state over HTTP (TanStack Query)
  const { data: authState, isError: authUnreachable } = useQuery({
    queryKey: ["auth-state"],
    queryFn: async () => {
      const r = await fetch("/api/auth/state");
      if (!r.ok) throw new Error("gateway unreachable");
      return (await r.json()) as { has_passkey: boolean };
    },
    enabled: !authed,
  });

  useEffect(() => {
    if (authUnreachable) setError("gateway unreachable");
  }, [authUnreachable]);

  async function submitPass(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (!res.ok) {
        setError("login failed — check the passphrase or bootstrap token");
        return;
      }
      setAuthed(true);
    } catch {
      setError("gateway unreachable");
    }
  }

  // ---- WS lifecycle: reconnect = re-hello = snapshot replace (gap-free)
  useEffect(() => {
    if (!authed) return;
    let closed = false;
    let retryMs = 500;

    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConn("open");
        retryMs = 500;
        ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), type: "req.hello", payload: {} }));
      };

      ws.onmessage = (ev) => {
        const frame = JSON.parse(ev.data as string);
        switch (frame.type) {
          case "res.hello":
            setSnapshot(frame.payload as Snapshot);
            setStreamText("");
            break;
          case "event.thread": {
            const m = frame.payload.message as Snapshot["messages"][number];
            setSnapshot((p) => (p ? { ...p, messages: [...p.messages, m] } : p));
            setStreamText("");
            if (m.role === "system") setStreamingJobId(null);
            break;
          }
          case "event.thread.update": {
            const u = frame.payload as { id: string; body: string };
            setSnapshot((p) =>
              p ? { ...p, messages: p.messages.map((m) => (m.id === u.id ? { ...m, body: u.body } : m)) } : p,
            );
            break;
          }
          case "event.thread.delta":
            setStreamText((t) => t + (frame.payload.delta as string));
            setStreamingJobId("live");
            break;
          case "event.approval": {
            const a = frame.payload as { id: string; job_id: string; card?: Partial<UiApproval>; status?: string };
            setApprovals((prev) => {
              const idx = prev.findIndex((x) => x.id === a.id);
              const card: UiApproval = {
                id: a.id,
                job_id: a.job_id,
                title: a.card?.title ?? "(approval)",
                diff_preview: a.card?.diff_preview,
                payload_summary: a.card?.payload_summary ?? {},
                action_kind: a.card?.action_kind ?? "",
                requires_receipt_for: a.card?.requires_receipt_for ?? "",
                source_flagged: a.card?.source_flagged,
                decided:
                  a.status === "approved" || a.status === "denied" || a.status === "pending"
                    ? a.status
                    : idx >= 0
                      ? prev[idx]!.decided
                      : "pending",
              };
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = card;
                return next;
              }
              return [card, ...prev];
            });
            break;
          }
          case "event.job": {
            const j = (frame.payload as { job: SnapshotJob }).job;
            setSnapshot((p) => (p ? { ...p, jobs: [j, ...p.jobs.filter((x) => x.id !== j.id)].slice(0, 50) } : p));
            if (["done", "failed", "cancelled"].includes(j.status)) setStreamingJobId(null);
            break;
          }
          case "event.threads.changed":
            ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), type: "req.hello", payload: {} }));
            break;
          case "res.error":
            if (frame.payload?.message) toast.error(String(frame.payload.message));
            break;
        }
      };

      ws.onclose = () => {
        setConn("closed");
        if (!closed) setTimeout(connect, retryMs), (retryMs = Math.min(retryMs * 2, 8000));
      };
    }
    connect();
    return () => {
      closed = true;
      wsRef.current?.close();
    };
  }, [authed]);

  // ---- actions
  function send() {
    const body = draft.trim();
    const threadId = snapshot?.threads[0]?.id;
    if (!body || !threadId) return;
    wsRef.current?.send(
      JSON.stringify({ v: 1, id: crypto.randomUUID(), type: "req.chat.send", payload: { thread_id: threadId, body } }),
    );
    setDraft("");
    setStreamingJobId("starting");
  }

  function createThread() {
    wsRef.current?.send(
      JSON.stringify({
        v: 1,
        id: crypto.randomUUID(),
        type: "req.thread.create",
        payload: { title: `Thread ${new Date().toLocaleString()}` },
      }),
    );
  }

  function decide(approval: UiApproval, kind: "approve" | "deny") {
    if (approval.decided && approval.decided !== "pending") return; // idempotent taps
    setApprovals((prev) =>
      prev.map((a) => (a.id === approval.id ? { ...a, decided: kind === "approve" ? "approved" : "denied" } : a)),
    );
    wsRef.current?.send(
      JSON.stringify({
        v: 1,
        id: crypto.randomUUID(),
        type: kind === "approve" ? "req.job.approve" : "req.job.deny",
        payload: { approval_id: approval.id, key: `tap-${approval.id}` }, // idempotency: one key per card
      }),
    );
  }

  function cancelJob(jobId: string) {
    wsRef.current?.send(
      JSON.stringify({ v: 1, id: crypto.randomUUID(), type: "req.job.cancel", payload: { job_id: jobId, key: `cancel-${jobId}` } }),
    );
  }

  // ---- boot / auth gate
  if (!authState && !error) {
    return <div className="grid h-dvh place-items-center text-muted-foreground">connecting…</div>;
  }

  if (!authed) {
    const first = authState?.has_passkey === false;
    return (
      <div className="grid h-dvh place-items-center px-4">
        <Card className="w-full max-w-sm py-6 shadow-lg">
          <div className="flex flex-col gap-3 px-6">
            <h1 className="text-lg leading-none font-semibold">
              🐝 <span className="text-primary">Hive</span>kit
            </h1>
            <p className="text-sm text-muted-foreground">
              {first ? "First login: set your owner passkey (min 8 chars)." : "Enter your owner passkey."}
            </p>
            <form onSubmit={submitPass} className="flex flex-col gap-3">
              <Input
                type="password"
                placeholder={first ? "new passkey" : "passkey"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoFocus
              />
              <Button type="submit">Continue</Button>
              {error && <p className="text-[13px] text-destructive">{error}</p>}
            </form>
          </div>
        </Card>
      </div>
    );
  }

  const jobs = snapshot?.jobs ?? [];
  const pendingApprovals = approvals.filter((a) => a.decided === "pending" || !a.decided).length;
  const master = (snapshot?.models as { master?: { model?: string } } | null)?.master?.model ?? "—";
  const worker = (snapshot?.models as { worker?: { model?: string } } | null)?.worker?.model ?? "—";
  const liveApproval = approvals.find((a) => (a.decided === "pending" || !a.decided) && !dismissedSheets.has(a.id));

  return (
    <div className="flex h-dvh flex-col">
      {/* ---- topbar ---- */}
      <header className="flex h-11 flex-none items-center gap-2 border-b bg-sidebar px-3.5 md:px-4">
        <span className="font-semibold tracking-wide">
          🐝 <span className="text-primary">Hive</span>kit
        </span>
        <Badge variant="outline" className="hidden max-w-40 truncate font-mono text-[10px] text-warn sm:inline-flex" title="master model">
          M {short(master)}
        </Badge>
        <Badge variant="outline" className="hidden max-w-40 truncate font-mono text-[10px] text-warn sm:inline-flex" title="worker model">
          W {short(worker)}
        </Badge>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              conn === "open" ? "bg-sage" : conn === "connecting" ? "bg-warn" : "bg-destructive",
            )}
            title={conn}
          />
          {conn === "open" ? "live" : conn}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---- desktop nav rail ---- */}
        <nav className="hidden w-44 flex-none flex-col gap-0.5 border-r bg-sidebar p-2.5 lg:w-48 md:flex">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                tab === id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50",
              )}
            >
              <span className="flex items-center gap-2">
                <Icon className="size-4 opacity-80" />
                {label}
              </span>
              {id === "receipts" && pendingApprovals > 0 && <span className="size-2 rounded-full bg-warn" />}
            </button>
          ))}
          <div className="mt-auto px-2.5 font-mono text-[10px] text-muted-foreground">v0.2 · single operator</div>
        </nav>

        {/* ---- main pane ---- */}
        <main className="flex min-w-0 flex-1 flex-col">
          {tab === "threads" && (
            <ChatView
              snapshot={snapshot}
              streamText={streamText}
              streaming={streamingJobId !== null}
              draft={draft}
              setDraft={setDraft}
              onSend={send}
              onCreateThread={createThread}
              onCancel={cancelJob}
            />
          )}
          {tab === "routines" && <RoutinesView snapshot={snapshot} />}
          {tab === "receipts" && <ReceiptsView approvals={approvals} jobs={jobs} />}
          {tab === "settings" && <SettingsView master={master} worker={worker} />}
        </main>

        {/* ---- desktop status rail: jobs ---- */}
        <aside className="hidden w-60 flex-none flex-col gap-2 overflow-y-auto border-l p-2.5 xl:w-64 lg:flex">
          <div className="flex items-center justify-between px-1.5">
            <h3 className="text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">Jobs</h3>
            <Button variant="ghost" size="icon" className="size-6" title="New thread" onClick={createThread}>
              <Plus className="size-3.5" />
            </Button>
          </div>
          {jobs.length === 0 && <div className="px-1.5 font-mono text-[11px] text-muted-foreground">none yet</div>}
          {jobs.slice(0, 12).map((j) => (
            <Card key={j.id} className="gap-1.5 px-2.5 py-2.5 text-[12.5px]">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 font-mono text-[10px] whitespace-nowrap ${
                    j.status === "done"
                      ? "bg-[#1c241c] text-sage"
                      : j.status === "failed" || j.status === "cancelled"
                        ? "bg-destructive/15 text-destructive"
                        : "bg-[#2a2314] text-primary"
                  }`}
                >
                  {j.status}
                </span>
                <span className="font-mono text-[11px]">${j.usd.toFixed(4)}</span>
              </div>
              <div className="truncate" title={j.title}>{j.title}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {j.master_model ? `M ${short(j.master_model)}` : ""} {j.worker_model ? `· W ${short(j.worker_model)}` : ""}
              </div>
              {["running", "needs_approval", "merging"].includes(j.status) && (
                <Button variant="ghost" size="sm" className="h-6 self-start px-2 text-xs" onClick={() => cancelJob(j.id)}>
                  stop
                </Button>
              )}
            </Card>
          ))}
        </aside>

      </div>

      {/* ---- mobile bottom tabs ---- */}
      <nav className="flex flex-none border-t bg-sidebar md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10.5px]",
              tab === id ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Icon className="size-[18px]" />
            {label}
            {id === "receipts" && pendingApprovals > 0 && <span className="absolute top-1.5 right-[22%] size-2 rounded-full bg-warn" />}
          </button>
        ))}
      </nav>

      {/* live approval — thumb-reachable bottom sheet, deny-first inside */}
      <Sheet
        open={!!liveApproval}
        onOpenChange={(open) => !open && liveApproval && setDismissedSheets((s) => new Set(s).add(liveApproval.id))}
      >
        {liveApproval && (
          <SheetContent
            side="bottom"
            className="mx-auto max-h-[70dvh] w-full max-w-xl overflow-y-auto rounded-t-xl border-primary/60 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:bottom-4 sm:rounded-xl"
            onOpenAutoFocus={(e) => e.preventDefault() /* a11y DoD: Approve never autofocused */}
          >
            <SheetHeader className="p-0">
              <SheetTitle className="text-sm">Approval needed</SheetTitle>
              <SheetDescription className="font-mono text-[11px]">irreversible action — your call</SheetDescription>
            </SheetHeader>
            <div className="rounded-lg border p-3">
              <ApprovalBody card={liveApproval} onDecide={decide} />
            </div>
          </SheetContent>
        )}
      </Sheet>
    </div>
  );
}

