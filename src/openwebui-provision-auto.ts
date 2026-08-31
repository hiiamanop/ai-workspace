import { mintApiKey } from "./openwebui-auth.ts";

/** Source for the Auto Pipe. Tools are executed here, not merely advertised to the model. */
export const AUTO_PIPE_SOURCE = String.raw`"""
Open WebUI Pipe — MADE-governed Auto model and tool orchestration.
"""
import json
from typing import AsyncGenerator
import aiohttp
from pydantic import BaseModel

class Pipe:
    class Valves(BaseModel):
        MADE_URL: str = "http://made:8000"
        UPSTREAM_BASE_URL: str = "http://host.docker.internal:20128/v1"
        UPSTREAM_API_KEY: str = ""
        BACKEND_URL: str = "http://app:3000"
        DEFAULT_CHAT_MODEL: str = "openrouter/minimax/minimax-m3:free"
        REQUEST_TIMEOUT_SECONDS: float = 120.0

    def __init__(self):
        self.valves = self.Valves()

    def pipes(self) -> list[dict]:
        return [{"id": "auto", "name": "Auto"}]

    def pipe(self, body: dict, __event_emitter__=None) -> AsyncGenerator:
        return self._run(body, __event_emitter__)

    async def _run(self, body: dict, emitter=None) -> AsyncGenerator:
        prompt = self._last_user(body)
        requested = self._requested_tools(prompt)
        approved = await self._approved_tools(requested, body)
        if approved:
            await self._status(emitter, "Running approved tools: " + ", ".join(approved))
            evidence = await self._run_tools(approved, prompt)
            if evidence:
                body = {**body, "messages": [
                    *body.get("messages", []),
                    {"role": "user", "content": "Use the following live tool evidence to answer. Do not claim you searched unless evidence is present:\n\n" + evidence},
                ]}
        ranked = await self._models(body)
        if not ranked:
            ranked = [self.valves.DEFAULT_CHAT_MODEL]
        for model in ranked:
            await self._status(emitter, "Trying model: " + model)
            async for chunk in self._stream(body, model):
                if isinstance(chunk, tuple):
                    continue
                yield chunk
            return
        yield "No model was available."

    @staticmethod
    def _last_user(body: dict) -> str:
        return next((str(m.get("content", "")) for m in reversed(body.get("messages", [])) if m.get("role") == "user"), "")

    @staticmethod
    def _requested_tools(prompt: str) -> list[str]:
        p = prompt.lower()
        if any(x in p for x in ("cari", "search", "internet", "marketplace", "harga", "berita", "terbaru", "find")):
            return ["web_search"]
        return []

    async def _approved_tools(self, requested: list[str], body: dict) -> list[str]:
        if not requested:
            return []
        candidates = [{"id": "web_search", "vendor": "searxng", "kind": "tool", "cost_per_1k_tokens": 0, "scores": {"cost": 0, "quality": .7, "latency": 3000, "business_risk": .2}}]
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(self.valves.MADE_URL + "/decide", json={"task": {"type": "chat", "data_classification": "internal", "estimated_context_tokens": sum(len(str(m.get("content", ""))) for m in body.get("messages", [])) // 4}, "decision_kind": "tool_selection", "candidates": candidates}, timeout=aiohttp.ClientTimeout(total=10)) as r:
                    if r.status != 200:
                        return []
                    d = await r.json()
                    return [x["id"] for x in d.get("ranking", []) if x.get("id") in requested] if not d.get("requires_human_approval") else []
        except Exception as e:
            print("Auto tool decision failed:", e)
            return []

    async def _run_tools(self, approved: list[str], prompt: str) -> str:
        parts = []
        if "web_search" in approved:
            try:
                async with aiohttp.ClientSession() as s:
                    async with s.post(self.valves.BACKEND_URL + "/api/web-search", json={"query": prompt, "language": "id"}, timeout=aiohttp.ClientTimeout(total=30)) as r:
                        if r.status == 200:
                            d = await r.json()
                            parts.append("web_search result:\n" + json.dumps(d, ensure_ascii=False))
                        else:
                            parts.append("web_search error: HTTP " + str(r.status))
            except Exception as e:
                parts.append("web_search error: " + str(e))
        return "\n\n".join(parts)

    async def _models(self, body: dict) -> list[str]:
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(self.valves.MADE_URL + "/candidates", timeout=aiohttp.ClientTimeout(total=10)) as r:
                    registry = await r.json()
                models = registry.get("models", [])
                candidates = [{"id": m["id"], "vendor": m.get("vendor", m.get("upstream_group", "omnirouter")), "kind": "model", "cost_per_1k_tokens": m.get("cost_per_1k_tokens", 0), "scores": m.get("scores", {"cost": 0, "quality": .5, "latency": 1, "business_risk": .5}), "context_window_tokens": m.get("context_window_tokens")} for m in models]
                async with s.post(self.valves.MADE_URL + "/decide", json={"task": {"type": "chat", "data_classification": "internal", "estimated_context_tokens": sum(len(str(m.get("content", ""))) for m in body.get("messages", [])) // 4}, "decision_kind": "model_selection", "candidates": candidates}, timeout=aiohttp.ClientTimeout(total=10)) as r:
                    if r.status != 200:
                        return []
                    d = await r.json()
                    if d.get("requires_human_approval") or not d.get("selected_candidate_id"):
                        return []
                    return [x["id"] for x in d.get("ranking", []) if x.get("id")]
        except Exception as e:
            print("Auto model decision failed:", e)
            return []

    async def _stream(self, body: dict, model: str):
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(self.valves.UPSTREAM_BASE_URL + "/chat/completions", json={**body, "model": model, "stream": True}, headers={"Authorization": "Bearer " + self.valves.UPSTREAM_API_KEY, "Content-Type": "application/json"}, timeout=aiohttp.ClientTimeout(total=self.valves.REQUEST_TIMEOUT_SECONDS)) as r:
                    if r.status != 200:
                        print("Auto upstream error:", r.status, await r.text())
                        return
                    async for raw in r.content:
                        line = raw.decode().strip()
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            return
                        try:
                            for c in json.loads(payload).get("choices", []):
                                text = c.get("delta", {}).get("content")
                                if text:
                                    yield text
                        except json.JSONDecodeError:
                            continue
        except Exception as e:
            print("Auto upstream exception:", e)

    async def _status(self, emitter, text: str):
        if emitter:
            await emitter({"type": "status", "data": {"description": text, "done": False}})
`;

export interface ProvisionAutoDeps {
  openwebuiUrl: string;
  adminEmail: string;
  adminPassword: string;
  openwebuiToken?: string;
  fetchFn?: typeof fetch;
}

export async function provisionAuto(deps: ProvisionAutoDeps): Promise<{ ok: boolean; error?: string }> {
  const fetchFn = deps.fetchFn ?? fetch;
  let token = deps.openwebuiToken;
  if (!token) {
    const minted = await mintApiKey({ openwebuiUrl: deps.openwebuiUrl, adminEmail: deps.adminEmail, adminPassword: deps.adminPassword, fetchFn });
    if (!minted.ok || !minted.apiKey) return { ok: false, error: minted.error ?? "failed to mint Open WebUI API key" };
    token = minted.apiKey;
  }
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const payload = { id: "made_multimodal", name: "Smart Presets & Capabilities", type: "pipe", content: AUTO_PIPE_SOURCE, meta: { description: "MADE-governed model and tool orchestration" } };
  const existing = await fetchFn(`${deps.openwebuiUrl}/api/v1/functions/id/made_multimodal`, { headers });
  const response = await fetchFn(`${deps.openwebuiUrl}/api/v1/functions/id/made_multimodal/${existing.ok ? "update" : "create"}`, { method: "POST", headers, body: JSON.stringify(payload) });
  if (!response.ok) return { ok: false, error: `Auto Pipe provisioning failed: ${response.status}` };
  return { ok: true };
}
