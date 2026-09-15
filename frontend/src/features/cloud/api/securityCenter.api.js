import { cloudAxios } from './axios';

/**
 * Security Center API client.
 *
 * One module, so the wire format is defined once. The three pages this
 * replaces each built their own requests — and `AlertsPage` used raw `fetch`
 * with a 10-second `setInterval` while everything else used TanStack Query,
 * which meant alert data had no cache, no shared invalidation and no way to
 * refresh when an assessment completed.
 *
 * `toQuery` is the single place list filters become a query string. The backend
 * accepts comma-separated values on every list filter, so a multi-select sends
 * one request rather than N requests the caller has to merge.
 */

const toQuery = (params = {}) => {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      if (!value.length) return;
      q.set(key, value.join(','));
      return;
    }
    if (typeof value === 'boolean') {
      q.set(key, value ? 'true' : 'false');
      return;
    }
    q.set(key, String(value));
  });
  const s = q.toString();
  return s ? `?${s}` : '';
};

// ── Metadata ────────────────────────────────────────────────────────────────
// The rule catalog, severity/category vocabulary, control catalog and scoring
// methodology all come from the backend rather than being duplicated here.
// A hard-coded copy in the UI is how a legend ends up describing behaviour the
// engine no longer has.
export const getMeta = async () => {
  const { data } = await cloudAxios.get('/security-center/meta');
  return data;
};

export const getMultiCloudOverview = async () => {
  const { data } = await cloudAxios.get('/security-center/overview');
  return data;
};

// ── Per-account reads ───────────────────────────────────────────────────────
export const getOverview = async (accountId) => {
  const { data } = await cloudAxios.get(`/security-center/${accountId}`);
  return data;
};

export const getFindings = async (accountId, filters = {}) => {
  const { data } = await cloudAxios.get(
    `/security-center/${accountId}/findings${toQuery(filters)}`,
  );
  return data;
};

export const getFinding = async (accountId, key) => {
  const { data } = await cloudAxios.get(`/security-center/${accountId}/findings/${key}`);
  return data;
};

export const getCompliance = async (accountId, framework) => {
  const { data } = await cloudAxios.get(
    `/security-center/${accountId}/compliance${toQuery({ framework })}`,
  );
  return data;
};

export const getControl = async (accountId, framework, controlId) => {
  const { data } = await cloudAxios.get(
    // Control ids contain slashes and parentheses — 164.312(a)(2)(iv) — so the
    // segment is encoded rather than interpolated raw.
    `/security-center/${accountId}/compliance/${framework}/${encodeURIComponent(controlId)}`,
  );
  return data;
};

export const getExposure = async (accountId) => {
  const { data } = await cloudAxios.get(`/security-center/${accountId}/exposure`);
  return data;
};

export const getIdentity = async (accountId) => {
  const { data } = await cloudAxios.get(`/security-center/${accountId}/identity`);
  return data;
};

export const getCoverage = async (accountId) => {
  const { data } = await cloudAxios.get(`/security-center/${accountId}/coverage`);
  return data;
};

export const getTrends = async (accountId, limit = 60) => {
  const { data } = await cloudAxios.get(
    `/security-center/${accountId}/trends${toQuery({ limit })}`,
  );
  return data;
};

export const getScoreExplanation = async (accountId) => {
  const { data } = await cloudAxios.get(`/security-center/${accountId}/score`);
  return data;
};

export const getDiagnostics = async (accountId) => {
  const { data } = await cloudAxios.get(`/security-center/${accountId}/diagnostics`);
  return data;
};

// ── Writes ──────────────────────────────────────────────────────────────────
export const runAssessment = async (accountId) => {
  const { data } = await cloudAxios.post(`/security-center/${accountId}/assess`);
  return data;
};

export const collectIdentity = async (accountId) => {
  const { data } = await cloudAxios.post(`/security-center/${accountId}/collect-identity`);
  return data;
};

export const setFindingStatus = async (accountId, key, payload) => {
  const { data } = await cloudAxios.post(
    `/security-center/${accountId}/findings/${key}/status`, payload,
  );
  return data;
};

// ── Alerts ──────────────────────────────────────────────────────────────────
export const getAlerts = async (params = {}) => {
  const { data } = await cloudAxios.get(`/security-center/alerts${toQuery(params)}`);
  return data;
};

export const actOnAlert = async (alertId, action, reason) => {
  const { data } = await cloudAxios.post(
    `/security-center/alerts/${alertId}/${action}`, { reason },
  );
  return data;
};

// ── Policies ────────────────────────────────────────────────────────────────
export const getPolicies = async (accountId) => {
  const { data } = await cloudAxios.get(
    `/security-center/policies${toQuery({ account_id: accountId })}`,
  );
  return data;
};

export const createPolicy = async (payload) => {
  const { data } = await cloudAxios.post('/security-center/policies', payload);
  return data;
};

export const updatePolicy = async (policyId, payload) => {
  const { data } = await cloudAxios.put(`/security-center/policies/${policyId}`, payload);
  return data;
};

export const deletePolicy = async (policyId) => {
  const { data } = await cloudAxios.delete(`/security-center/policies/${policyId}`);
  return data;
};
