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

/** Transport that streams the backend's WebSocket endpoint (MADE-connected model turn). */
export function createMadeTransport(): AgentTransport {
  let socket: WebSocket | null = null;
  let reconnectAttempts = 0;

  function ensureSocket(): WebSocket {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return socket;
    }
    const next = new WebSocket(`ws://${location.host}`);
    next.addEventListener('open', () => {
      reconnectAttempts = 0;
    });
    next.addEventListener('close', () => {
      if (reconnectAttempts >= 5) return;
      const delay = 500 * 2 ** reconnectAttempts;
      reconnectAttempts += 1;
      setTimeout(ensureSocket, delay);
    });
    socket = next;
    return next;
  }

  return {
    stream(request, callbacks) {
      const ws = ensureSocket();
      let turnId: string | null = null;
      let done = false;
      let inToolInputPhase = false;

      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        ws.removeEventListener('message', handleMessage);
        ws.removeEventListener('open', send);
        ws.removeEventListener('close', handleClose);
        fn();
      };

      const handleClose = () => {
        finish(() => callbacks.onError('WebSocket connection lost during streaming'));
      };

      function handleMessage(event: MessageEvent) {
        const msg = JSON.parse(String(event.data));

        if (msg.type === 'turn_started') {
          turnId = msg.turnId;
          return;
        }
        if (turnId && msg.turnId && msg.turnId !== turnId) return;

        if (msg.type === 'delta') {
          callbacks.onDelta(msg.text);
        } else if (msg.type === 'tool_call_delta') {
          if (!inToolInputPhase) {
            inToolInputPhase = true;
            callbacks.onPhase?.({ kind: 'tool-input' });
          }
        } else if (msg.type === 'tool_result') {
          inToolInputPhase = false;
        } else if (msg.type === 'done') {
          if (msg.stopped) {
            finish(() => callbacks.onDone());
            return;
          }
          const result = msg.result as { type: 'text'; text: string } | { type: 'tool_calls'; calls: Parameters<typeof callbacks.onToolCall>[0][]; text?: string };
          if (result.type === 'text') {
            finish(() => callbacks.onDone());
          } else if (result.type === 'tool_calls') {
            for (const call of result.calls) callbacks.onToolCall(call);
            finish(() => callbacks.onDone());
          } else {
            finish(() => callbacks.onError('unexpected result shape in done event'));
          }
        } else if (msg.type === 'error') {
          finish(() => callbacks.onError(msg.error ?? 'unknown streaming error'));
        }
      }

      ws.addEventListener('message', handleMessage);
      ws.addEventListener('close', handleClose);

      const send = () =>
        ws.send(JSON.stringify({ type: 'agent-turn', system: request.system, messages: request.messages, tools: request.tools }));
      if (ws.readyState === WebSocket.OPEN) {
        send();
      } else {
        ws.addEventListener('open', send, { once: true });
      }

      return {
        cancel: () => {
          if (turnId) ws.send(JSON.stringify({ type: 'stop', turnId }));
          finish(() => callbacks.onDone());
        },
      };
    },
  };
}
