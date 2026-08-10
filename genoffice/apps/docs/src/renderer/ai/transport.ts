import { createIpcTransport, type AgentTransport } from '@genoffice/agent-core'
import type { AiSettings } from '../../shared/ipc'
import { t } from '../i18n/locale'

/** The shared IPC transport wired to the docs preload bridge (window.desktop). */
export function createElectronTransport(getSettings: () => AiSettings): AgentTransport {
  return createIpcTransport<AiSettings>({
    onStream: (listener) => window.desktop.onAiStream(listener),
    start: (request) => window.desktop.aiStream(request),
    cancel: (requestId) => void window.desktop.aiStreamCancel(requestId),
    getSettings,
    unknownErrorText: () => t('aiUnknownError'),
    timeoutErrorText: () => t('aiTimeoutError'),
    creditsErrorText: () => t('aiCreditsExhausted'),
  })
}

/** Transport that calls the backend's /api/agent-turn endpoint (MADE-connected model turn). */
export function createMadeTransport(): AgentTransport {
  return {
    stream(request, callbacks) {
      let cancelled = false;

      (async () => {
        try {
          const res = await fetch("/api/agent-turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          });

          if (cancelled) return;

          if (!res.ok) {
            const body = await res.json().catch(() => ({ error: `request failed: ${res.status}` }));
            callbacks.onError(body.error ?? `request failed: ${res.status}`);
            return;
          }

          const data = (await res.json()) as
            | { type: "text"; text: string }
            | { type: "tool_calls"; calls: Parameters<typeof callbacks.onToolCall>[0][]; text?: string };

          if (cancelled) return;

          if (data.type === "text") {
            if (data.text) callbacks.onDelta(data.text);
            callbacks.onDone();
          } else if (data.type === "tool_calls") {
            if (data.text) callbacks.onDelta(data.text);
            for (const call of data.calls) callbacks.onToolCall(call);
            callbacks.onDone();
          } else {
            callbacks.onError("unexpected response shape from /api/agent-turn");
          }
        } catch (err) {
          if (!cancelled) callbacks.onError((err as Error).message);
        }
      })();

      return { cancel: () => { cancelled = true; callbacks.onDone(); } };
    },
  };
}
