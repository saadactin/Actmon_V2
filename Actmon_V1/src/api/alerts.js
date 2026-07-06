import client, { ensureArray } from './client';

// ─── Dynamic alert threshold rules (Percona-PMM style) ──────────────────────
export const listRules = async () => {
  const res = await client.get('/alerts/rules');
  return ensureArray(res.data);
};

export const createRule = async (data) => {
  const res = await client.post('/alerts/rules', data);
  return res.data;
};

export const updateRule = async (id, data) => {
  const res = await client.put(`/alerts/rules/${id}`, data);
  return res.data;
};

export const toggleRule = async (id, enabled) => {
  const res = await client.patch(`/alerts/rules/${id}/toggle`, { enabled });
  return res.data;
};

export const deleteRule = async (id) => {
  await client.delete(`/alerts/rules/${id}`);
};

// ─── Live active alerts feed (evaluated from enabled rules) ─────────────────
export const listActiveAlerts = async () => {
  const res = await client.get('/alerts/active');
  return ensureArray(res.data);
};

// AI analysis of an alert (ActMon AI / Groq) — fallback when no live connection
export const analyzeAlert = async (payload) => {
  const res = await client.post('/alerts/analyze', payload);
  return res.data;
};

// Resolve an alert's source → a live DB connection for the real-time drill-down
export const drillContext = async (source, metric = '') => {
  const res = await client.get('/alerts/drill-context', { params: { source, metric } });
  return res.data;
};

// Real step-wise DB diagnostics for an alert
export const listDiagnostics = async (tech, metric = '') => {
  const res = await client.get('/alerts/diagnostics', { params: { tech, metric } });
  return res.data;
};
export const runDiagnostic = async (payload) => {
  const res = await client.post('/alerts/diagnostics/run', payload);
  return res.data;
};

// Agentic investigation: AI decides & runs the next command from prior output
export const agentStep = async (payload) => {
  const res = await client.post('/alerts/agent/step', payload);
  return res.data;
};

// ─── (legacy — kept for compatibility; SMTP now lives in Settings) ──────────
export const getConfig = async () => {
  const res = await client.get('/alerts/config');
  return res.data;
};
export const upsertConfig = async (data) => {
  const res = await client.put('/alerts/config', data);
  return res.data;
};
