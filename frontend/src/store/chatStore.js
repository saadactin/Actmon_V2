import { create } from 'zustand';
import { TOKEN_KEY } from '@/api/client';
import { uid } from '@/lib/format';
import { APP } from '@/config/app.config';

/**
 * ActMon AI — the floating widget's conversation.
 *
 * A plain fetch + ReadableStream reader, not axios: the backend's `/chat/stream`
 * is Server-Sent Events, and axios buffers the whole response before resolving,
 * which would turn a token-by-token stream into one delayed blob. The endpoint's
 * own docstring says as much — "Frontend reads this with fetch + ReadableStream."
 *
 * Kept in a store rather than component state so the conversation survives the
 * widget closing — opening it back up mid-page-nav resumes where you left off,
 * the way a real assistant would.
 */

const KEY = 'actmon.chat';
const POS_KEY = 'actmon.chat.pos';
const MAX_STORED = 40; // caps localStorage growth; the backend only reads the last 20 anyway
export const LAUNCHER_SIZE = 80; // must match the <ActmonAiMark size={80}> button in ChatWidget

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function persist(messages) {
  try {
    localStorage.setItem(KEY, JSON.stringify(messages.slice(-MAX_STORED)));
  } catch {
    /* non-fatal — a full or disabled localStorage just means no history on reload */
  }
}

/**
 * Keep the launcher on-screen after a resize (rotating a tablet, undocking a
 * laptop) — dragged all the way to a corner at 1920px wide, it would otherwise
 * sit half off-screen the next time the window opens at 1280px.
 */
function clampPosition(pos) {
  const maxX = Math.max(0, window.innerWidth - LAUNCHER_SIZE);
  const maxY = Math.max(0, window.innerHeight - LAUNCHER_SIZE);
  return { x: Math.min(Math.max(pos.x, 0), maxX), y: Math.min(Math.max(pos.y, 0), maxY) };
}

/** Bottom-right, matching where the widget has always defaulted to. */
function defaultPosition() {
  return clampPosition({ x: window.innerWidth - LAUNCHER_SIZE - 24, y: window.innerHeight - LAUNCHER_SIZE - 24 });
}

function loadPosition() {
  try {
    const raw = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) return clampPosition(raw);
  } catch {
    /* fall through to the default */
  }
  return defaultPosition();
}

function persistPosition(pos) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* non-fatal — it just won't remember where it was dragged to */
  }
}

/** `/mysql-dashboard/42/slow-queries` → { db_type: 'mysql', connection_id: 42 }. */
function contextFromPath(pathname) {
  const m = pathname.match(/^\/([a-z]+)-dashboard\/(\d+)/);
  return m ? { db_type: m[1], connection_id: Number(m[2]) } : {};
}

let controller = null; // in-flight request, so a second send or a close can abort it

export const useChatStore = create((set, get) => ({
  open: false,
  messages: load(), // [{ id, role: 'user'|'assistant', content, error? }]
  streaming: false,

  // Where the launcher sits — top-left corner, in viewport pixels. Dragging is
  // the whole point of this being state rather than a fixed Tailwind class; see
  // ChatWidget's pointer handlers for how it gets here.
  position: loadPosition(),
  setPosition: (pos) => {
    const clamped = clampPosition(pos);
    set({ position: clamped });
    persistPosition(clamped);
  },
  /** Re-clamp on resize without forgetting which corner the user actually chose. */
  reclampPosition: () => set((s) => {
    const clamped = clampPosition(s.position);
    persistPosition(clamped);
    return { position: clamped };
  }),

  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),

  clear: () => {
    controller?.abort();
    set({ messages: [], streaming: false });
    persist([]);
  },

  /** Stop the current response mid-stream, keeping whatever text already arrived. */
  stop: () => controller?.abort(),

  send: async (text, pathname) => {
    const message = text.trim();
    if (!message || get().streaming) return;

    const userMsg = { id: uid(), role: 'user', content: message };
    const assistantMsg = { id: uid(), role: 'assistant', content: '' };
    const history = get().messages.map(({ role, content }) => ({ role, content }));

    const next = [...get().messages, userMsg, assistantMsg];
    set({ messages: next, streaming: true });
    persist(next);

    const setAssistant = (patch) => {
      set((s) => {
        const messages = s.messages.map((m) => (m.id === assistantMsg.id ? { ...m, ...patch } : m));
        persist(messages);
        return { messages };
      });
    };

    controller = new AbortController();
    const token = localStorage.getItem(TOKEN_KEY);

    try {
      const res = await fetch(`${APP.apiBase}/chatbot/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message,
          history,
          context: { page: pathname, ...contextFromPath(pathname || '') },
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(res.status === 401 ? 'Sign in to use ActMon AI.' : `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let text = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; a frame may still be
        // incomplete at the end of a chunk, so only consume what's whole.
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';

        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let evt;
          try {
            evt = JSON.parse(line.slice(5).trim());
          } catch {
            continue; // a malformed frame shouldn't kill an otherwise-good stream
          }

          if (evt.type === 'token') {
            text += evt.text ?? '';
            setAssistant({ content: text });
          } else if (evt.type === 'error') {
            setAssistant({ content: text || evt.message || 'Something went wrong.', error: true });
          }
          // 'done' carries suggestions/actions the widget doesn't render yet —
          // nothing to do with it here.
        }
      }

      if (!text) setAssistant({ content: 'No response.', error: true });
    } catch (err) {
      if (err.name === 'AbortError') {
        // user-initiated stop — keep whatever text streamed in so far, unmarked
      } else {
        setAssistant({
          content: err.offline || err.message === 'Failed to fetch'
            ? 'Cannot reach ActMon AI. Check that the backend is running.'
            : err.message || 'Something went wrong.',
          error: true,
        });
      }
    } finally {
      controller = null;
      set({ streaming: false });
    }
  },
}));
