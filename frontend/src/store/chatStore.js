import { create } from 'zustand';
import { TOKEN_KEY } from '@/api/client';
import { uid } from '@/lib/format';
import { APP } from '@/config/app.config';
import {
  listChatSessions, createChatSession, getChatSession,
  renameChatSession, deleteChatSession, appendChatMessage,
} from '@/api/chatSessions';

/**
 * ActMon AI — conversation store, shared by the floating widget and the
 * full-page chat.
 *
 * Sessions/messages are persisted server-side, per signed-in user
 * (`/api/v1/chatbot/sessions/*` — ownership-enforced there, not just filtered
 * here) so "User A never sees User B's conversations" holds even if someone
 * inspects this store's state directly. The actual AI turn still streams
 * through the existing, UNCHANGED `/chatbot/chat/stream` endpoint via plain
 * fetch + ReadableStream (SSE) — this store only adds persistence around it.
 *
 * If persistence calls fail (e.g. no token / offline), `send()` degrades to
 * the old ephemeral behaviour rather than blocking the chat — a session is a
 * nice-to-have wrapper around the conversation, not a hard requirement to talk
 * to the assistant at all.
 */

const POS_KEY = 'actmon.chat.pos';
const LAST_SESSION_KEY = 'actmon.chat.lastSession';
export const LAUNCHER_SIZE = 80; // must match the <ActmonAiMark size={80}> button in ChatWidget

/** Keep the launcher on-screen after a resize. */
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

  position: loadPosition(),
  setPosition: (pos) => {
    const clamped = clampPosition(pos);
    set({ position: clamped });
    persistPosition(clamped);
  },
  reclampPosition: () => set((s) => {
    const clamped = clampPosition(s.position);
    persistPosition(clamped);
    return { position: clamped };
  }),

  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),

  // ── sessions (sidebar) ──────────────────────────────────────────────────
  sessions: [],
  sessionsLoading: false,
  activeSessionId: null,
  messages: [], // the ACTIVE session's messages: [{ id, role, content, error?, suggestions?, actions?, actionProposal? }]
  streaming: false,

  loadSessions: async (q) => {
    set({ sessionsLoading: true });
    try {
      const sessions = await listChatSessions(q);
      set({ sessions });
    } catch {
      set({ sessions: [] }); // signed out / offline — sidebar just shows no history
    } finally {
      set({ sessionsLoading: false });
    }
  },

  /** Resets to a blank conversation — the actual session row is created lazily,
   * on the first message actually sent, so clicking "New Chat" and changing
   * your mind never litters the sidebar with empty conversations. */
  newChat: () => {
    controller?.abort();
    localStorage.removeItem(LAST_SESSION_KEY);
    set({ activeSessionId: null, messages: [], streaming: false });
  },
  /** Alias kept for existing callers — "Clear conversation" now means "start
   * a new one," since the conversation itself is durable session history. */
  clear: () => get().newChat(),

  openSession: async (id) => {
    controller?.abort();
    set({ streaming: false });
    try {
      const data = await getChatSession(id);
      set({
        activeSessionId: id,
        messages: (data.messages || []).map((m) => ({ id: uid(), role: m.role, content: m.content, error: m.error })),
      });
      try { localStorage.setItem(LAST_SESSION_KEY, String(id)); } catch { /* non-fatal */ }
    } catch {
      get().newChat(); // deleted / not found / not owned — behave like New Chat, never show someone else's data
    }
  },

  /** Resumes the last-open conversation on mount, if any — same behaviour as
   * the old localStorage-backed store, just re-fetched from the server. */
  resumeLastSession: async () => {
    let id = null;
    try { id = Number(localStorage.getItem(LAST_SESSION_KEY)) || null; } catch { /* non-fatal */ }
    if (id) await get().openSession(id);
  },

  renameSession: async (id, title) => {
    const clean = (title || '').trim();
    if (!clean) return;
    const updated = await renameChatSession(id, clean);
    set((s) => ({ sessions: s.sessions.map((sess) => (sess.id === id ? { ...sess, title: updated.title } : sess)) }));
  },

  deleteSession: async (id) => {
    await deleteChatSession(id);
    set((s) => ({
      sessions: s.sessions.filter((sess) => sess.id !== id),
      ...(s.activeSessionId === id ? { activeSessionId: null, messages: [] } : {}),
    }));
    if (get().activeSessionId === null) {
      try { localStorage.removeItem(LAST_SESSION_KEY); } catch { /* non-fatal */ }
    }
  },

  /** Stop the current response mid-stream, keeping whatever text already arrived. */
  stop: () => controller?.abort(),

  /** Re-sends the user message that preceded a failed assistant reply — drops
   * that failed pair and runs the exact same `send()` path fresh, rather than
   * patching the old bubble in place, so retry behaves identically to a new
   * message (session persistence, abort handling, etc. all just work). */
  retry: (messageId, pathname) => {
    const msgs = get().messages;
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx < 1) return;
    const failed = msgs[idx];
    const userMsg = msgs[idx - 1];
    if (!failed?.error || userMsg?.role !== 'user') return;
    set({ messages: msgs.slice(0, idx - 1) });
    get().send(userMsg.content, pathname);
  },

  /** Runs a proposed action (restart/kill/reboot/…) the assistant is not allowed to
   * execute on its own — the backend re-verifies RBAC and this password server-side
   * before calling the exact same service function the Infra page's own buttons use. */
  confirmAction: async (messageId, password) => {
    const proposal = get().messages.find((m) => m.id === messageId)?.actionProposal;
    if (!proposal) throw new Error('No pending action to confirm.');
    const token = localStorage.getItem(TOKEN_KEY);
    const res = await fetch(`${APP.apiBase}/chatbot/action/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        action: proposal.action,
        resource_id: proposal.resource?.id,
        module: proposal.module,
        params: proposal.params,
        password,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
    const resultLine = `✓ ${data.message || 'Done.'}`;
    set((s) => ({
      messages: s.messages.map((m) => (m.id === messageId
        ? { ...m, actionProposal: null, content: `${m.content}\n\n${resultLine}` }
        : m)),
    }));
    const sid = get().activeSessionId;
    if (sid) appendChatMessage(sid, 'assistant', resultLine).catch(() => {});
    return data;
  },

  /** Dismisses a proposed action without running it. */
  cancelAction: (messageId) => set((s) => ({
    messages: s.messages.map((m) => (m.id === messageId ? { ...m, actionProposal: null } : m)),
  })),

  send: async (text, pathname) => {
    const message = text.trim();
    if (!message || get().streaming) return;

    // Lazily create the session on the FIRST message of a fresh conversation.
    let sessionId = get().activeSessionId;
    if (!sessionId) {
      try {
        const created = await createChatSession(null);
        sessionId = created.id;
        set((s) => ({ activeSessionId: sessionId, sessions: [created, ...s.sessions] }));
        try { localStorage.setItem(LAST_SESSION_KEY, String(sessionId)); } catch { /* non-fatal */ }
      } catch {
        // Not signed in / session service unreachable — keep chatting without
        // persistence rather than blocking the assistant entirely.
        sessionId = null;
      }
    }

    const userMsg = { id: uid(), role: 'user', content: message };
    const assistantMsg = { id: uid(), role: 'assistant', content: '' };
    const history = get().messages.map(({ role, content }) => ({ role, content }));

    set({ messages: [...get().messages, userMsg, assistantMsg], streaming: true });
    if (sessionId) appendChatMessage(sessionId, 'user', message).catch(() => {});

    const setAssistant = (patch) => {
      set((s) => ({ messages: s.messages.map((m) => (m.id === assistantMsg.id ? { ...m, ...patch } : m)) }));
    };

    controller = new AbortController();
    const token = localStorage.getItem(TOKEN_KEY);
    let finalText = '';
    let finalError = false;

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
          } else if (evt.type === 'clarify') {
            text = evt.text || text;
            setAssistant({ content: text, suggestions: evt.suggestions || [] });
          } else if (evt.type === 'action_proposal') {
            text = text || evt.summary || 'I can do that — confirm to proceed.';
            setAssistant({
              content: text,
              actionProposal: {
                action: evt.action, module: evt.module, resource: evt.resource,
                params: evt.params, summary: evt.summary,
              },
            });
          } else if (evt.type === 'done') {
            setAssistant({ suggestions: evt.suggestions || [], actions: evt.actions || [] });
          } else if (evt.type === 'error') {
            text = text || evt.error || evt.message || 'Something went wrong.';
            finalError = true;
            setAssistant({ content: text, error: true });
          }
        }
      }

      finalText = text || 'No response.';
      if (!text) setAssistant({ content: 'No response.', error: true });
    } catch (err) {
      if (err.name === 'AbortError') {
        // user-initiated stop — keep whatever text streamed in so far, unmarked
        finalText = get().messages.find((m) => m.id === assistantMsg.id)?.content || '';
      } else {
        finalError = true;
        finalText = err.offline || err.message === 'Failed to fetch'
          ? 'Cannot reach ActMon AI. Check that the backend is running.'
          : err.message || 'Something went wrong.';
        setAssistant({ content: finalText, error: true });
      }
    } finally {
      controller = null;
      set({ streaming: false });
      if (sessionId && finalText) {
        appendChatMessage(sessionId, 'assistant', finalText, finalError)
          .then(() => get().loadSessions())
          .catch(() => {});
      }
    }
  },
}));
