/**
 * Hivekit web app — the only client (todo/05).
 *
 * Desktop: nav rail + thread + status rail. Phone (≤720px): bottom tabs.
 * Live over WS; on reconnect the client re-hellos and the snapshot REPLACES
 * local state — catch-up is structural, no event replay needed.
 *
 * Honest v1 boundaries rendered as disabled-with-reason, never fake:
 *   - Routines: list + countdown from the real snapshot; CRUD frames land
 *     with the routines gateway stream.
 *   - Models/Connectors: read-only badges; credential writes need
 *     req.connector.set (stream 06).
 *   - Receipts: decisions observed live (event.approval) + approval history
 *     carried on job cards.
 */
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Snapshot, SnapshotMessage, SnapshotJob } from "@hivekit/protocol";
import "./style.css";

type ConnState = "connecting" | "open" | "closed";
type Tab = "threads" | "routines" | "receipts" | "settings";

interface ApprovalCard {
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

interface Msg {
  id: string;
  role: string;
  body: string;
  card?: unknown;
}

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [hasPasskey, setHasPasskey] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [conn, setConn] = useState<ConnState>("connecting");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [streamText, setStreamText] = useState("");
  const [tab, setTab] = useState<Tab>("threads");
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [streamingJobId, setStreamingJobId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  // ---- auth
  useEffect(() => {
    fetch("/api/auth/state")
      .then((r) => r.json())
      .then((s: { has_passkey: boolean }) => setHasPasskey(s.has_passkey))
      .catch(() => setError("gateway unreachable"));
  }, []);

  async function submitPass(e: Event) {
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
          case "res.hello": {
            setSnapshot(frame.payload as Snapshot);
            setStreamText("");
            break;
          }
          case "event.thread": {
            const m = frame.payload.message as SnapshotMessage;
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
          case "event.thread.delta": {
            setStreamText((t) => t + (frame.payload.delta as string));
            setStreamingJobId("live");
            break;
          }
          case "event.approval": {
            const a = frame.payload as { id: string; job_id: string; card?: ApprovalCard; status?: string };
            setApprovals((prev) => {
              const idx = prev.findIndex((x) => x.id === a.id);
              const card: ApprovalCard = {
                id: a.id,
                job_id: a.job_id,
                title: a.card?.title ?? "(approval)",
                diff_preview: a.card?.diff_preview,
                payload_summary: a.card?.payload_summary ?? {},
                action_kind: a.card?.action_kind ?? "",
                requires_receipt_for: a.card?.requires_receipt_for ?? "",
                source_flagged: a.card?.source_flagged,
                decided: a.status ?? (idx >= 0 ? prev[idx]!.decided : "pending"),
              };
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = card;
                return next;
              }
              return [card, ...prev];
            });
            setTab((t) => (t === "threads" ? t : t));
            break;
          }
          case "event.job": {
            const j = (frame.payload as { job: SnapshotJob }).job;
            setSnapshot((p) =>
              p
                ? {
                    ...p,
                    jobs: [j, ...p.jobs.filter((x) => x.id !== j.id)].slice(0, 50),
                  }
                : p,
            );
            if (["done", "failed", "cancelled"].includes(j.status)) setStreamingJobId(null);
            break;
          }
          case "event.threads.changed": {
            ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), type: "req.hello", payload: {} }));
            break;
          }
          case "res.error": {
            if (frame.payload?.message) setError(String(frame.payload.message));
            break;
          }
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

  // ---- autoscroll thread
  useEffect(() => {
    if (tab === "threads" && threadRef.current)
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [snapshot?.messages.length, streamText, tab]);

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

  function decide(approval: ApprovalCard, kind: "approve" | "deny") {
    if (approval.decided && approval.decided !== "pending") return; // idempotent taps
    setApprovals((prev) => prev.map((a) => (a.id === approval.id ? { ...a, decided: kind === "approve" ? "approved" : "denied" } : a)));
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

  // ---- render
  if (hasPasskey === null && !error) return <div class="boot">connecting…</div>;

  if (!authed) {
    return (
      <div class="center">
        <form class="card auth" onSubmit={submitPass}>
          <h1>
            🐝 <span>Hive</span>kit
          </h1>
          <p class="muted">{hasPasskey === false ? "First login: set your owner passkey (min 8 chars)." : "Enter your owner passkey."}</p>
          <input
            type="password"
            placeholder={hasPasskey === false ? "new passkey" : "passkey"}
            value={passphrase}
            onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
            autofocus
          />
          <button type="submit">Continue</button>
          {error && <p class="err">{error}</p>}
        </form>
      </div>
    );
  }

  const messages: Msg[] = snapshot?.messages ?? [];
  const hasThreads = (snapshot?.threads.length ?? 0) > 0;
  const jobs = snapshot?.jobs ?? [];
  const running = jobs.find((j) => ["planning", "running", "merging", "needs_approval"].includes(j.status));
  const pendingApprovals = approvals.filter((a) => a.decided === "pending" || !a.decided).length;
  const master = (snapshot?.models as { master?: { model?: string } } | null)?.master?.model ?? "—";
  const worker = (snapshot?.models as { worker?: { model?: string } } | null)?.worker?.model ?? "—";

  return (
    <div class="shell">
      <header class="topbar">
        <span class="brand">
          🐝 <span>Hive</span>kit
        </span>
        <span class="badge" title="master model">
          M {short(master)}
        </span>
        <span class="badge" title="worker model">
          W {short(worker)}
        </span>
        <span class="conn">
          <span class={`dot ${conn}`} title={conn} />
          {conn === "open" ? "live" : conn}
        </span>
      </header>

      <div class="body-grid">
        {/* ---- desktop nav rail ---- */}
        <nav class="rail">
          <h3>Hive</h3>
          <NavBtn tab="threads" set={setTab} label="Threads" active={tab === "threads"} />
          <NavBtn tab="routines" set={setTab} label="Routines" active={tab === "routines"} />
          <NavBtn tab="receipts" set={setTab} label="Receipts" active={tab === "receipts"} badge={pendingApprovals} />
          <NavBtn tab="settings" set={setTab} label="Settings" active={tab === "settings"} />
          <div class="railfoot mono">v0.2 · single operator</div>
        </nav>

        {/* ---- main pane ---- */}
        <main class="pane">
          {tab === "threads" && (
            <>
              <div class="statusbar mono">
                {running
                  ? `job ${running.id.slice(0, 8)} · ${running.status} · $${running.usd.toFixed(4)}`
                  : hasThreads
                    ? "idle — say the word"
                    : "no threads yet"}
                {running && (
                  <button class="btn ghost" onClick={() => cancelJob(running.id)}>
                    stop
                  </button>
                )}
              </div>
              <div class="thread" ref={threadRef}>
                {!hasThreads && (
                  <div class="empty">
                    <p>No threads yet.</p>
                    <button class="btn" onClick={createThread}>
                      Create first thread
                    </button>
                  </div>
                )}
                {messages.map((m) => (
                  <Message key={m.id} m={m} />
                ))}
                {streamText && (
                  <div class="msg master">
                    <div class="who">master</div>
                    <div class="body streaming">
                      <p>{streamText}</p>
                    </div>
                  </div>
                )}
                {streamingJobId === "live" && <div class="mono pulse">▍ working…</div>}
              </div>
              {hasThreads && (
                <footer class="composer">
                  <input
                    placeholder="Message the hive…"
                    value={draft}
                    onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => e.key === "Enter" && send()}
                  />
                  <button class="btn" onClick={send} disabled={!draft.trim()}>
                    Send
                  </button>
                </footer>
              )}
            </>
          )}

          {tab === "routines" && <RoutinesTab snapshot={snapshot} />}
          {tab === "receipts" && <ReceiptsTab approvals={approvals} jobs={jobs} />}
          {tab === "settings" && <SettingsTab master={master} worker={worker} />}
        </main>

        {/* ---- desktop status rail: jobs ---- */}
        <aside class="rail jobs">
          <h3>Jobs</h3>
          {jobs.length === 0 && <div class="mono muted">none yet</div>}
          {jobs.slice(0, 12).map((j) => (
            <div key={j.id} class="jobcard">
              <div class="rowline">
                <span class={`pill ${j.status}`}>{j.status}</span>
                <span class="mono">${j.usd.toFixed(4)}</span>
              </div>
              <div class="jobtitle">{j.title}</div>
              <div class="mono muted">
                {j.master_model ? `M ${short(j.master_model)}` : ""} {j.worker_model ? `· W ${short(j.worker_model)}` : ""}
              </div>
              {["running", "needs_approval", "merging"].includes(j.status) && (
                <button class="btn ghost tiny" onClick={() => cancelJob(j.id)}>
                  stop
                </button>
              )}
            </div>
          ))}
        </aside>
      </div>

      {/* ---- mobile bottom tabs ---- */}
      <nav class="tabs">
        <TabBtn icon="💬" label="Threads" active={tab === "threads"} set={setTab} tab="threads" badge={0} />
        <TabBtn icon="⏱" label="Routines" active={tab === "routines"} set={setTab} tab="routines" badge={0} />
        <TabBtn icon="🧾" label="Receipts" active={tab === "receipts"} set={setTab} tab="receipts" badge={pendingApprovals} />
        <TabBtn icon="⚙️" label="Settings" active={tab === "settings"} set={setTab} tab="settings" badge={0} />
      </nav>

      {/* approval toasts — always visible, thumb-reachable bottom sheet on mobile */}
      {approvals
        .filter((a) => a.decided === "pending" || !a.decided)
        .slice(0, 1)
        .map((a) => (
          <ApprovalSheet key={a.id} a={a} onDecide={decide} />
        ))}

      {error && (
        <div class="toast err" onClick={() => setError("")}>
          {error}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function short(modelId: string): string {
  if (modelId.length <= 22) return modelId;
  return `${modelId.slice(0, 10)}…${modelId.slice(-8)}`;
}

function Message({ m }: { m: Msg }) {
  const isOp = m.role === "op";
  const systemCard = (m.card as ApprovalCard | null) ?? null;
  return (
    <div class={`msg ${m.role}${isOp ? " op" : ""}`}>
      <div class="who">{m.role}</div>
      <div class="body">
        {systemCard ? <ApprovalInner card={systemCard} onDecide={() => {}} frozen /> : <p>{m.body}</p>}
      </div>
    </div>
  );
}

function ApprovalInner({ card, onDecide, frozen }: { card: ApprovalCard; onDecide: (a: ApprovalCard, k: "approve" | "deny") => void; frozen?: boolean }) {
  return (
    <div class="approvecard" role="group" aria-label={`Approval required: ${card.title}`}>
      <div class="rowline">
        <strong>{card.title}</strong>
        {card.source_flagged && <span class="pill warn">source flagged</span>}
      </div>
      <div class="mono muted">{card.requires_receipt_for}</div>
      {card.diff_preview && (
        <pre class="diff" tabIndex={0}>
          {card.diff_preview}
        </pre>
      )}
      {Object.keys(card.payload_summary ?? {}).length > 0 && (
        <div class="mono payload">
          {Object.entries(card.payload_summary).map(([k, v]) => (
            <div key={k}>
              <b>{k}</b> {v}
            </div>
          ))}
        </div>
      )}
      {!frozen && (
        <div class="actions">
          {/* Deny first + never autofocused: Approve is never the default focus (a11y DoD). */}
          <button class="btn ghost" onClick={() => onDecide(card, "deny")}>
            Deny
          </button>
          <button class="btn" onClick={() => onDecide(card, "approve")}>
            Approve
          </button>
        </div>
      )}
      {frozen && card.decided && <div class="mono">{card.decided}</div>}
    </div>
  );
}

function ApprovalSheet({ a, onDecide }: { a: ApprovalCard; onDecide: (a: ApprovalCard, k: "approve" | "deny") => void }) {
  return (
    <div class="sheet" role="dialog" aria-label="Approval needed">
      <ApprovalInner card={a} onDecide={onDecide} />
    </div>
  );
}

function RoutinesTab({ snapshot }: { snapshot: Snapshot | null }) {
  const routines = snapshot?.routines ?? [];
  return (
    <div class="tabpane">
      <h2>Routines</h2>
      {routines.length === 0 && <p class="muted">No routines yet. Create them from chat ("every morning at 07:00 …") once routine frames land.</p>}
      {routines.map((r) => {
        const next = r.next_run_at ? new Date(r.next_run_at) : null;
        const mins = next ? Math.max(0, Math.round((next.getTime() - Date.now()) / 60000)) : null;
        return (
          <div key={r.id} class="jobcard">
            <div class="rowline">
              <strong>{r.name}</strong>
              <span class={`pill ${r.enabled ? "done" : "cancelled"}`}>{r.enabled ? "enabled" : "paused"}</span>
            </div>
            <div class="mono muted">
              cron {r.cron} · notify {r.notify}
            </div>
            <div class="mono">{mins !== null ? `next run in ${mins}m` : "no run scheduled"}</div>
          </div>
        );
      })}
      <p class="mono muted">pause/resume/edit arrives with routine CRUD frames (stream 06).</p>
    </div>
  );
}

function ReceiptsTab({ approvals, jobs }: { approvals: ApprovalCard[]; jobs: SnapshotJob[] }) {
  return (
    <div class="tabpane">
      <h2>Receipts</h2>
      <p class="muted mono">every irreversible action, who decided, when</p>
      {approvals.length === 0 && <p class="muted">No approvals observed this session. Historical receipts render from the ledger once the receipts endpoint lands.</p>}
      {approvals.map((a) => (
        <div key={a.id} class="jobcard">
          <div class="rowline">
            <span class={`pill ${a.decided === "approved" ? "done" : a.decided === "denied" ? "cancelled" : "running"}`}>{a.decided ?? "pending"}</span>
            <span class="mono muted">{a.requires_receipt_for}</span>
          </div>
          <div>{a.title}</div>
          {a.diff_preview && (
            <pre class="diff" tabIndex={0}>
              {a.diff_preview}
            </pre>
          )}
        </div>
      ))}
      <h2>Jobs</h2>
      {jobs.map((j) => (
        <div key={j.id} class="jobcard">
          <div class="rowline">
            <span class={`pill ${j.status}`}>{j.status}</span>
            <span class="mono">${j.usd.toFixed(4)}</span>
          </div>
          <div>{j.title}</div>
        </div>
      ))}
    </div>
  );
}

function SettingsTab({ master, worker }: { master: string; worker: string }) {
  return (
    <div class="tabpane">
      <h2>Settings</h2>
      <div class="jobcard">
        <div class="rowline">
          <span class="mono">master</span>
          <span class="mono">{master}</span>
        </div>
        <div class="rowline">
          <span class="mono">worker</span>
          <span class="mono">{worker}</span>
        </div>
      </div>
      <p class="muted">
        Model swaps and connector credentials write through <code>req.models.set</code> / <code>req.connector.set</code> — those frames land with stream 06.
        Until then, configure providers in <code>config/hivekit.yaml</code> + provider API keys as environment variables
        (<code>OPENROUTER_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>). Secrets are never echoed back — by design, there is nothing to echo yet.
      </p>
    </div>
  );
}

function NavBtn({ tab, label, active, set, badge }: { tab: Tab; label: string; active: boolean; set: (t: Tab) => void; badge?: number }) {
  return (
    <button class={`item ${active ? "active" : ""}`} onClick={() => set(tab)}>
      {label}
      {badge ? <span class="dotn" title={`${badge} pending`} /> : null}
    </button>
  );
}

function TabBtn({ tab, label, icon, active, set, badge }: { tab: Tab; label: string; icon: string; active: boolean; set: (t: Tab) => void; badge: number }) {
  return (
    <button class={`tabbtn ${active ? "active" : ""}`} onClick={() => set(tab)}>
      <span class="ic">{icon}</span>
      {label}
      {badge ? <span class="dotn" /> : null}
    </button>
  );
}

render(<App />, document.getElementById("app")!);
