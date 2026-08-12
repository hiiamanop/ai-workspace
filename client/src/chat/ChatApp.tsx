import { useEffect, useRef, useState, type FormEvent } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: WebSearchResult[];
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

function faviconUrl(pageUrl: string): string {
  try {
    return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(pageUrl).hostname}`;
  } catch {
    return "";
  }
}

function withCitationChips(text: string, sources?: WebSearchResult[]): string {
  if (!sources || sources.length === 0) return text;
  return text.replace(/\[(\d+)\]/g, (match, numStr: string) => {
    const source = sources[Number(numStr) - 1];
    if (!source) return match;
    const favicon = faviconUrl(source.url);
    const img = favicon ? `<img src="${favicon}" alt="" class="cite-fav"/>` : "";
    return `<sup class="cite" data-cite="${numStr}">${img}</sup>`;
  });
}

function Markdown({ text, sources }: { text: string; sources?: WebSearchResult[] }) {
  const html = DOMPurify.sanitize(marked.parse(withCitationChips(text, sources), { async: false }) as string, {
    ADD_ATTR: ["data-cite"],
  });
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

function SourceCard({ source, x, y, onClose }: { source: WebSearchResult; x: number; y: number; onClose: () => void }) {
  let hostname = "";
  try {
    hostname = new URL(source.url).hostname;
  } catch {
    /* leave hostname blank if the URL doesn't parse */
  }
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 10 }} />
      <div
        style={{
          position: "fixed",
          left: x,
          top: y,
          zIndex: 11,
          background: "#222",
          color: "#fff",
          borderRadius: 8,
          padding: 12,
          maxWidth: 280,
          boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{hostname}</div>
        <a href={source.url} target="_blank" rel="noopener noreferrer" style={{ color: "#fff", fontWeight: 600, textDecoration: "none" }}>
          {source.title}
        </a>
        {source.publishedDate && <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>{source.publishedDate}</div>}
      </div>
    </>
  );
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 500;

export function ChatApp() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [turnId, setTurnId] = useState<string | null>(null);
  const [awaitingFirstToken, setAwaitingFirstToken] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [popover, setPopover] = useState<{ source: WebSearchResult; x: number; y: number } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const draftRef = useRef("");
  const turnIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(-1);
  const reconnectAttemptsRef = useRef(0);
  const sourcesRef = useRef<WebSearchResult[]>([]);

  useEffect(() => {
    turnIdRef.current = turnId;
  }, [turnId]);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connect() {
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setConnectionLost(false);
      if (turnIdRef.current) {
        ws.send(JSON.stringify({ type: "resume", turnId: turnIdRef.current, lastSeq: lastSeqRef.current }));
      }
    };

    ws.onmessage = (event) => handleWsMessage(String(event.data));

    ws.onclose = () => {
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setConnectionLost(true);
        return;
      }
      const delay = RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttemptsRef.current;
      reconnectAttemptsRef.current += 1;
      setTimeout(connect, delay);
    };
  }

  function handleWsMessage(raw: string) {
    const msg = JSON.parse(raw) as {
      type: string;
      seq?: number;
      turnId?: string;
      text?: string;
      error?: string;
      results?: WebSearchResult[];
    };

    if (msg.type === "turn_started") {
      setTurnId(msg.turnId ?? null);
      setAwaitingFirstToken(true);
      lastSeqRef.current = -1;
      sourcesRef.current = [];
      return;
    }

    if (typeof msg.seq === "number") {
      lastSeqRef.current = msg.seq;
    }

    if (msg.type === "delta") {
      draftRef.current += msg.text ?? "";
      setAssistantDraft(draftRef.current);
      setAwaitingFirstToken(false);
    } else if (msg.type === "tool_call_delta" || msg.type === "tool_result") {
      setAwaitingFirstToken(false);
    } else if (msg.type === "sources") {
      sourcesRef.current = msg.results ?? [];
    } else if (msg.type === "done") {
      const finalText = draftRef.current;
      const finalSources = sourcesRef.current;
      draftRef.current = "";
      setMessages((prev) => [...prev, { role: "assistant", content: finalText, sources: finalSources }]);
      setAssistantDraft("");
      setTurnId(null);
      setAwaitingFirstToken(false);
    } else if (msg.type === "error") {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${msg.error}` }]);
      draftRef.current = "";
      setAssistantDraft("");
      setTurnId(null);
      setAwaitingFirstToken(false);
    }
  }

  function sendTurn(msgs: ChatMessage[]) {
    wsRef.current?.send(JSON.stringify({ type: "chat", messages: msgs }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    const next = [...messages, { role: "user" as const, content: message }];
    setMessages(next);
    setMessage("");
    sendTurn(next);
  }

  function stop() {
    if (turnId) {
      wsRef.current?.send(JSON.stringify({ type: "stop", turnId }));
    }
  }

  function regenerate() {
    const lastIndex = messages.length - 1;
    if (lastIndex < 0 || messages[lastIndex].role !== "assistant") return;
    const truncated = messages.slice(0, lastIndex);
    setMessages(truncated);
    sendTurn(truncated);
  }

  function handleCitationClick(e: React.MouseEvent, sources?: WebSearchResult[]) {
    const target = (e.target as HTMLElement).closest("[data-cite]");
    if (!target || !sources) return;
    const n = Number(target.getAttribute("data-cite"));
    const source = sources[n - 1];
    if (!source) return;
    const rect = target.getBoundingClientRect();
    setPopover({ source, x: rect.left, y: rect.bottom + 4 });
  }

  const lastIsAssistant = messages.length > 0 && messages[messages.length - 1].role === "assistant";

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "40px auto", padding: "0 16px" }}>
      <h1>AI Workspace — Chat</h1>
      {connectionLost && <div style={{ color: "#b00", marginBottom: 8 }}>Connection lost. Reload the page to reconnect.</div>}
      <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, minHeight: 200, marginBottom: 12 }}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{ marginBottom: 8 }}
            onClick={m.role === "assistant" ? (e) => handleCitationClick(e, m.sources) : undefined}
          >
            <strong>{m.role === "user" ? "You" : "Assistant"}:</strong>
            {m.role === "assistant" ? <Markdown text={m.content} sources={m.sources} /> : <div>{m.content}</div>}
          </div>
        ))}
        {turnId && (
          <div style={{ marginBottom: 8 }}>
            <strong>Assistant:</strong>
            {awaitingFirstToken ? <div>typing…</div> : <Markdown text={assistantDraft} />}
          </div>
        )}
      </div>
      {lastIsAssistant && !turnId && (
        <button type="button" onClick={regenerate} style={{ marginBottom: 8 }}>
          Regenerate
        </button>
      )}
      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Type a message..."
          autoComplete="off"
          required
          style={{ flex: 1, padding: 8 }}
        />
        {turnId ? (
          <button type="button" onClick={stop} style={{ padding: "8px 16px" }}>
            Stop
          </button>
        ) : (
          <button type="submit" style={{ padding: "8px 16px" }}>
            Send
          </button>
        )}
      </form>
      {popover && <SourceCard source={popover.source} x={popover.x} y={popover.y} onClose={() => setPopover(null)} />}
    </div>
  );
}
