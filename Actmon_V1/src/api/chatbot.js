/**
 * ActMon AI Chatbot API
 * All chatbot-related API calls.
 */

const BASE = '/api/v1/chatbot';

function authHeaders() {
  const token = localStorage.getItem('actmon_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Stream a chat message. Calls onToken for each token, onDone when complete.
 * Returns an AbortController so the caller can cancel mid-stream.
 */
export function streamChat({ message, history = [], context = null, onToken, onDone, onError }) {
  const controller = new AbortController();

  (async () => {
    try {
      const resp = await fetch(`${BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ message, history, context }),
        signal: controller.signal,
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep partial line
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'token') onToken?.(evt.text);
            else if (evt.type === 'done') onDone?.(evt);
            else if (evt.type === 'error') onError?.(evt.error);
          } catch (_) {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') onError?.(err.message);
    }
  })();

  return controller;
}

/** List all configured connections (for context selector). */
export async function fetchConnections() {
  const resp = await fetch(`${BASE}/connections`, { headers: authHeaders() });
  const data = await resp.json();
  return data.connections || [];
}

/** Download a report CSV. Returns a Blob URL the caller can .click(). */
export function downloadReport(type, connId) {
  let url = `${BASE}/report/${type}`;
  if (connId && connId !== 'unknown') url += `/${connId}`;
  const token = localStorage.getItem('actmon_token');
  // Trigger browser download via hidden anchor
  const a = document.createElement('a');
  a.href = url + (token ? `?token=${token}` : '');
  a.download = `actmon_${type}_report.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** Quick SQL template (no LLM, instant). */
export async function quickSQL(queryType, dbType, params = {}) {
  const resp = await fetch(`${BASE}/quick-sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ query_type: queryType, db_type: dbType, params }),
  });
  return resp.json();
}
