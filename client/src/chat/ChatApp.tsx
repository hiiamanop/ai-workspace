import { useState, type FormEvent } from "react";

interface ChatResponse {
  selectedCandidateId: string;
  reply: string;
  toolsUsed: string[];
}

function summarizeTools(toolsUsed: string[]): string {
  const counts: Record<string, number> = {};
  for (const name of toolsUsed) {
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");
}

export function ChatApp() {
  const [message, setMessage] = useState("");
  const [log, setLog] = useState<string[]>([]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const sent = message;
    setLog((prev) => [...prev, `You: ${sent}`]);
    setMessage("");

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: sent }),
    });
    const body = await res.json();

    if (!res.ok) {
      setLog((prev) => [...prev, `Error: ${body.error}`]);
      return;
    }

    const response = body as ChatResponse;
    let text = `[${response.selectedCandidateId}] ${response.reply}`;
    if (response.toolsUsed && response.toolsUsed.length > 0) {
      text += `\n[tools: ${summarizeTools(response.toolsUsed)}]`;
    }
    setLog((prev) => [...prev, text]);
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "40px auto", padding: "0 16px" }}>
      <h1>AI Workspace — Chat</h1>
      <div
        style={{
          whiteSpace: "pre-wrap",
          border: "1px solid #ccc",
          borderRadius: 8,
          padding: 12,
          minHeight: 200,
          marginBottom: 12,
        }}
      >
        {log.map((entry, i) => (
          <div key={i}>
            {entry}
            {"\n"}
          </div>
        ))}
      </div>
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
        <button type="submit" style={{ padding: "8px 16px" }}>
          Send
        </button>
      </form>
    </div>
  );
}
