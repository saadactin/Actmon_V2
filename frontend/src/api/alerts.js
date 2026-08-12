import client, { ensureArray } from './client';

/** Live alerts, evaluated server-side from the ENABLED rules plus collector events. */
export const listActiveAlerts = () =>
  client.get('/alerts/active').then((r) => ensureArray(r.data));

/**
 * Acknowledge alerts.
 *
 * Only collector-generated alerts can be acknowledged — they're rows in
 * agent_notifications with integer ids. Rule-evaluated alerts are derived live
 * from current host state (their id looks like "12:3"), so there is nothing to
 * mark read: they clear when the condition clears. Callers must filter to
 * ackable ids first; see isAckable().
 *
 * @param {number[]} ids  empty array acknowledges everything unread
 */
export const acknowledgeAlerts = (ids = []) =>
  client.post('/alerts/active/ack', { ids }).then((r) => r.data);

/** true when this alert is a stored notification rather than live rule state. */
export const isAckable = (alert) => /^n\d+$/.test(String(alert?.id ?? ''));

/** "n42" → 42, for the ack payload. */
export const ackIdOf = (alert) => Number(String(alert.id).slice(1));

/* ── rules ────────────────────────────────────────────────────────────────── */

export const listRules = () =>
  client.get('/alerts/rules').then((r) => ensureArray(r.data));

export const createRule = (payload) =>
  client.post('/alerts/rules', payload).then((r) => r.data);

export const updateRule = (id, payload) =>
  client.put(`/alerts/rules/${id}`, payload).then((r) => r.data);

export const toggleRule = (id, enabled) =>
  client.patch(`/alerts/rules/${id}/toggle`, { enabled }).then((r) => r.data);

export const deleteRule = (id) =>
  client.delete(`/alerts/rules/${id}`).then((r) => r.data);

/* ── investigation ────────────────────────────────────────────────────────── */

/** Resolve an alert's source host to a live DB connection, for drill-down. */
export const drillContext = (source, metric = '') =>
  client.get('/alerts/drill-context', { params: { source, metric } }).then((r) => r.data);

/** ActMon AI: explain the alert and suggest fixes. */
export const analyzeAlert = (payload) =>
  client.post('/alerts/analyze', payload).then((r) => r.data);
