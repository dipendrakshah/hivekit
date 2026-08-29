import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageBubble } from "./message-bubble";
import type { Snapshot, SnapshotMessage } from "@hivekit/protocol";

export function ChatView({
  snapshot,
  streamText,
  streaming,
  draft,
  setDraft,
  onSend,
  onCreateThread,
  onCancel,
}: {
  snapshot: Snapshot | null;
  streamText: string;
  streaming: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  onCreateThread: () => void;
  onCancel: (jobId: string) => void;
}) {
  const threadRef = useRef<HTMLDivElement | null>(null);
  const messages: SnapshotMessage[] = snapshot?.messages ?? [];
  const hasThreads = (snapshot?.threads.length ?? 0) > 0;
  const running = (snapshot?.jobs ?? []).find((j) => ["planning", "running", "merging", "needs_approval"].includes(j.status));

  // autoscroll thread
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages.length, streamText]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2 font-mono text-[11px] text-muted-foreground">
        <span className="truncate">
          {running
            ? `job ${running.id.slice(0, 8)} · ${running.status} · $${running.usd.toFixed(4)}`
            : hasThreads
              ? "idle — say the word"
              : "no threads yet"}
        </span>
        {running && (
          <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={() => onCancel(running.id)}>
            stop
          </Button>
        )}
      </div>

      <div ref={threadRef} className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-4 md:px-6">
        {!hasThreads && (
          <div className="py-16 text-center text-muted-foreground">
            <p className="mb-3">No threads yet.</p>
            <Button onClick={onCreateThread}>Create first thread</Button>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
        {streamText && (
          <div className="flex flex-col items-start">
            <div className="mb-0.5 font-mono text-[11px] text-muted-foreground">master</div>
            <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-primary/60 bg-card px-3.5 py-2 text-sm break-words whitespace-pre-wrap shadow-xs md:max-w-[75%]">
              {streamText}
            </div>
          </div>
        )}
        {streaming && <div className="animate-pulse font-mono text-[11px] text-primary">▍ working…</div>}
      </div>

      {hasThreads && (
        <footer className="flex flex-none items-center gap-2 border-t bg-sidebar/60 px-3 py-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] md:pb-2.5">
          <Input
            placeholder="Message the hive…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && onSend()}
            className="h-10 rounded-full bg-background md:h-9"
          />
          <Button onClick={onSend} disabled={!draft.trim()} size="lg" className="rounded-full">
            Send
          </Button>
        </footer>
      )}
    </div>
  );
}
