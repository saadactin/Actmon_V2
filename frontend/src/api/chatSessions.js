import client, { ensureArray } from './client';

/**
 * Per-user AI Chat session persistence — `/api/v1/chatbot/sessions/*`.
 * Ownership is enforced server-side (a session id that isn't the caller's own
 * 404s), so this client never needs to filter by user itself.
 */

export const listChatSessions = (q) =>
  client.get('/chatbot/sessions', { params: q ? { q } : undefined }).then((r) => ensureArray(r.data?.sessions ?? r.data));

export const createChatSession = (title) =>
  client.post('/chatbot/sessions', { title }).then((r) => r.data);

export const getChatSession = (id) =>
  client.get(`/chatbot/sessions/${id}`).then((r) => r.data);

export const renameChatSession = (id, title) =>
  client.patch(`/chatbot/sessions/${id}`, { title }).then((r) => r.data);

export const deleteChatSession = (id) =>
  client.delete(`/chatbot/sessions/${id}`).then((r) => r.data);

export const appendChatMessage = (id, role, content, error = false) =>
  client.post(`/chatbot/sessions/${id}/messages`, { role, content, error }).then((r) => r.data);

/** Super Admin → AI Chat Sessions audit — `/api/v1/admin/ai-chat-sessions*`. */
export const listChatAudit = (params) =>
  client.get('/admin/ai-chat-sessions', { params }).then((r) => ensureArray(r.data));

export const getChatAuditMessages = (sessionId) =>
  client.get(`/admin/ai-chat-sessions/${sessionId}/messages`).then((r) => r.data);
