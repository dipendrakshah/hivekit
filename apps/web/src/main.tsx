/**
 * Hivekit web app — stream-01 shape (todo/05 is the full pass).
 *
 * Login/setup → thread view with live streaming over WS. Desktop nav rail and
 * mobile bottom tabs arrive in stream 05; this build already renders the
 * thread-first interface the PRD commits to.
 */
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Snapshot, SnapshotMessage } from "@hivekit/protocol";
import "./style.css";

type ConnState = "connecting" | "open" | "closed";

interface Msg {
  id: string;
  role: string;
  body: string;
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
  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // ---- auth state
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

  // ---- websocket lifecycle
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
        ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), type: "req.hello", payload: {} }));
      };
      ws.onmessage = (ev) => {
        const frame = JSON.parse(ev.data as string);
        if (frame.type === "res.hello") {
          setSnapshot(frame.payload as Snapshot);
          setStreamText("");
        } else if (frame.type === "event.thread") {
          const m = frame.payload.message as SnapshotMessage;
          setSnapshot((prev: Snapshot | null): Snapshot | null =>
            prev ? { ...prev, messages: [...prev.messages, m] } : prev,
          );
          setStreamText("");
        } else if (frame.type === "event.thread.update") {
          const u = frame.payload as { id: string; body: string };
          setSnapshot((prev: Snapshot | null): Snapshot | null =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.map((m) =>
                    m.id === u.id ? { ...m, body: u.body } : m,
                  ),
                }
              : prev,
          );
        } else if (frame.type === "event.thread.delta") {
          setStreamText((t: string) => t + (frame.payload.delta as string));
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
    if (!body || !snapshot?.threads.length) return;
    const threadId = snapshot.threads[0]?.id;
    if (!threadId) return;
    wsRef.current?.send(
      JSON.stringify({ v: 1, id: crypto.randomUUID(), type: "req.chat.send", payload: { thread_id: threadId, body } }),
    );
    setDraft("");
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

  // ---- render
  if (hasPasskey === null && !error) return <div class="boot">connecting…</div>;

  if (!authed) {
    return (
      <div class="center">
        <form class="card auth" onSubmit={submitPass}>
          <h1>🐝 Hivekit</h1>
          <p class="muted">
            {hasPasskey === false
              ? "First login: set your owner passkey."
              : "Enter your owner passkey."}
          </p>
          <input
            type="password"
            placeholder={hasPasskey === false ? "new passkey (min 8 chars)" : "passkey"}
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

  return (
    <div class="shell">
      <header>
        <span class="brand">🐝 Hivekit</span>
        <span class={`dot ${conn}`} title={conn} />
      </header>
      <div class="thread" ref={logRef}>
        {!hasThreads && (
          <div class="empty">
            <p>No threads yet.</p>
            <button onClick={createThread}>Create first thread</button>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} class={`msg ${m.role}`}>
            <span class="who">{m.role}</span>
            <p>{m.body}</p>
          </div>
        ))}
        {streamText && (
          <div class="msg master streaming">
            <span class="who">master</span>
            <p>{streamText}</p>
          </div>
        )}
      </div>
      {hasThreads && (
        <footer>
          <input
            placeholder="Message the hive…"
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
          />
          <button onClick={send}>Send</button>
        </footer>
      )}
    </div>
  );
}

render(<App />, document.getElementById("app")!);