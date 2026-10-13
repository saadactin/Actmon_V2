import { cloudAxios } from './axios';

/**
 * Identity & Access (CIEM) API client.
 *
 * Same wire dialect as the Security Center's and Resource Intelligence's:
 * every list filter is sent comma-joined (`privilege=ADMIN,PRIVILEGED`),
 * because the backend reads each as one comma-separated string. `toQuery` is
 * the single place that happens.
 *
 * Nothing here filters or sorts client-side. The identity estate can run to
 * tens of thousands of principals, and the backend already does the work in
 * SQL — fetching the lot to filter in the browser is the thing §34 forbids.
 */

export const toQuery = (params = {}) => {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      if (!value.length) return;
      q.set(key, value.join(','));
      return;
    }
    if (typeof value === 'boolean') {
      if (value) q.set(key, 'true');
      return;
    }
    q.set(key, String(value));
  });
  const s = q.toString();
  return s ? `?${s}` : '';
};

// ── Vocabulary ──────────────────────────────────────────────────────────────
// Served by the backend so the legend and the engine cannot drift apart.
export const getMeta = async () => {
  const { data } = await cloudAxios.get('/identity/meta');
  return data;
};

// ── Dashboard and table ─────────────────────────────────────────────────────
export const getOverview = async (accountId) => {
  const { data } = await cloudAxios.get(`/identity/${accountId}/overview`);
  return data;
};

export const getPrincipals = async (accountId, filters = {}) => {
  const { data } = await cloudAxios.get(
    `/identity/${accountId}/principals${toQuery(filters)}`,
  );
  return data;
};

export const getPrincipal = async (identityId) => {
  const { data } = await cloudAxios.get(`/identity/principals/${identityId}`);
  return data;
};

export const getPermissions = async (identityId, filters = {}) => {
  const { data } = await cloudAxios.get(
    `/identity/principals/${identityId}/permissions${toQuery(filters)}`,
  );
  return data;
};

export const getUsage = async (identityId) => {
  const { data } = await cloudAxios.get(`/identity/principals/${identityId}/usage`);
  return data;
};

export const getBlastRadius = async (identityId) => {
  const { data } = await cloudAxios.get(
    `/identity/principals/${identityId}/blast-radius`,
  );
  return data;
};

export const getTrust = async (identityId) => {
  const { data } = await cloudAxios.get(`/identity/principals/${identityId}/trust`);
  return data;
};

export const getEvents = async (identityId, limit = 100) => {
  const { data } = await cloudAxios.get(
    `/identity/principals/${identityId}/events${toQuery({ limit })}`,
  );
  return data;
};

export const getRecommendations = async (identityId) => {
  const { data } = await cloudAxios.get(
    `/identity/principals/${identityId}/recommendations`,
  );
  return data;
};

// ── Explorer and reverse queries ────────────────────────────────────────────
export const canDo = async (accountId, { identityId, action, resource }) => {
  const { data } = await cloudAxios.get(
    `/identity/${accountId}/permission-query${toQuery({
      identity_id: identityId,
      action,
      resource,
    })}`,
  );
  return data;
};

export const whoCanAccess = async (accountId, { action, resource, capability, limit }) => {
  const { data } = await cloudAxios.get(
    `/identity/${accountId}/who-can-access${toQuery({
      action,
      resource,
      capability,
      limit,
    })}`,
  );
  return data;
};

/**
 * "Who can access this?" for one resource, called from the Resources tab.
 *
 * The key is encoded because an ARN and an ARM id both carry slashes; the
 * backend matches it as a `:path` parameter so it arrives intact.
 */
export const getResourcePrincipals = async (accountId, resourceKey, limit = 100) => {
  const { data } = await cloudAxios.get(
    `/identity/${accountId}/resources/${encodeURIComponent(resourceKey)}/principals${toQuery({ limit })}`,
  );
  return data;
};

export const getTrustMap = async (accountId, externalOnly = false) => {
  const { data } = await cloudAxios.get(
    `/identity/${accountId}/trust-map${toQuery({ external_only: externalOnly })}`,
  );
  return data;
};

export const search = async (accountId, q, limit = 25) => {
  const { data } = await cloudAxios.get(
    `/identity/${accountId}/search${toQuery({ q, limit })}`,
  );
  return data;
};

// ── Collection and analysis ─────────────────────────────────────────────────
export const collect = async (accountId) => {
  const { data } = await cloudAxios.post(`/identity/${accountId}/collect`);
  return data;
};

export const analyze = async (accountId, params = {}) => {
  const { data } = await cloudAxios.post(
    `/identity/${accountId}/analyze${toQuery(params)}`,
  );
  return data;
};

// ── Requests, approvals and sessions ────────────────────────────────────────
export const createRequest = async (accountId, body) => {
  const { data } = await cloudAxios.post(`/identity/${accountId}/access-requests`, body);
  return data;
};

export const getRequests = async (accountId, filters = {}) => {
  const { data } = await cloudAxios.get(
    `/identity/${accountId}/access-requests${toQuery(filters)}`,
  );
  return data;
};

export const getRequest = async (requestId) => {
  const { data } = await cloudAxios.get(`/identity/access-requests/${requestId}`);
  return data;
};

export const approveRequest = async (requestId, comment) => {
  const { data } = await cloudAxios.post(
    `/identity/access-requests/${requestId}/approve`,
    { comment },
  );
  return data;
};

export const rejectRequest = async (requestId, comment) => {
  const { data } = await cloudAxios.post(
    `/identity/access-requests/${requestId}/reject`,
    { comment },
  );
  return data;
};

/** Applying is deliberate: `confirm` is required and the backend refuses without it. */
export const applyRequest = async (requestId) => {
  const { data } = await cloudAxios.post(
    `/identity/access-requests/${requestId}/apply`,
    { confirm: true },
  );
  return data;
};

export const getSessions = async (accountId, filters = {}) => {
  const { data } = await cloudAxios.get(
    `/identity/${accountId}/sessions${toQuery(filters)}`,
  );
  return data;
};

export const revokeSession = async (sessionId, comment) => {
  const { data } = await cloudAxios.post(`/identity/sessions/${sessionId}/revoke`, {
    comment,
  });
  return data;
};

export const proposeRightsizing = async (identityId) => {
  const { data } = await cloudAxios.post(
    `/identity/principals/${identityId}/rightsize`,
  );
  return data;
};

export const getAuditLog = async (accountId, filters = {}) => {
  const { data } = await cloudAxios.get(`/identity/${accountId}/audit${toQuery(filters)}`);
  return data;
};
