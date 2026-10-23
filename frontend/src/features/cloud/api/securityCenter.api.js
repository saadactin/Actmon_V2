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

/**
 * Download the audit-ready compliance pack and hand it to the browser.
 *
 *   framework  one framework key, or omitted for every framework that applies
 *   format     'pdf' | 'xlsx' | 'json' | 'zip' (zip = all three + SHA256SUMS)
 *
 * The server names the file and returns the pack's ID and SHA-256 in headers,
 * which are passed back so the UI can show which pack was issued. A refusal
 * (403 without reports:export) arrives as a JSON body inside a Blob, because
 * the request asked for a blob — it is unpacked so the user sees the reason
 * rather than "Request failed with status code 403".
 */
export const downloadComplianceExport = async (accountId, { framework, format = 'pdf' } = {}) => {
  let response;
  try {
    response = await cloudAxios.get(
      `/security-center/${accountId}/compliance/export${toQuery({ framework, format })}`,
      { responseType: 'blob', timeout: 180000 },
    );
  } catch (err) {
    const blob = err?.response?.data;
    if (blob instanceof Blob) {
      try {
        const body = JSON.parse(await blob.text());
        if (body?.detail) err.message = String(body.detail);
      } catch { /* not JSON — keep axios's message */ }
    }
    throw err;
  }
  const disposition = response.headers?.['content-disposition'] || '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match ? match[1] : `compliance-audit.${format}`;
  const url = URL.createObjectURL(response.data);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return {
    filename,
    packId: response.headers?.['x-actmon-pack-id'] || null,
    sha256: response.headers?.['x-actmon-pack-sha256'] || null,
  };
};

export const getExposure = async (accountId) => {
  const { data } = await cloudAxios.get(`/security-center/${accountId}/exposure`);
  return data;
};

export const getIdentity = async (accountId) => {
  const { data } = await cloudAxios.get(`/security-center/${accountId}/identity`);
  return data;
};

// ── Attack paths ────────────────────────────────────────────────────────────
// Routes from a confirmed internet entry point to a resource worth reaching,
// walked over the same topology graph the Topology tab draws. The server ranks
// them, so `limit` is a display cap on an already-ordered list rather than an
// arbitrary slice the client then has to re-sort.
export const getAttackPaths = async (accountId, { maxDepth, limit, refresh } = {}) => {
  const { data } = await cloudAxios.get(
    `/security-center/${accountId}/attack-paths${toQuery({
      max_depth: maxDepth, limit, refresh,
    })}`,
  );
  return data;
};

// Software identity per compute resource, joined to reachability. Read
// `source_configured` before `resources`: with no CVE feed wired up an empty
// vulnerability list means "not assessed", not "not vulnerable".
export const getVulnerabilities = async (accountId) => {
  const { data } = await cloudAxios.get(`/security-center/${accountId}/vulnerabilities`);
  return data;
};

// Behavioural detections over the Event Log. Read `availability` before
// concluding anything from an empty list: a detector whose required field is
// never populated reports as unavailable, not as finding nothing.
export const getThreats = async (accountId, { days } = {}) => {
  const { data } = await cloudAxios.get(
    `/security-center/${accountId}/threats${toQuery({ days })}`,
  );
  return data;
};

// Signals from every subsystem grouped by the resource or principal they
// concern. An incident needs two DIFFERENT kinds of signal.
export const getIncidents = async (accountId, { days } = {}) => {
  const { data } = await cloudAxios.get(
    `/security-center/${accountId}/incidents${toQuery({ days })}`,
  );
  return data;
};

// Recovery-control posture per data store. A configuration review, not malware
// detection — `unassessable_controls` is why there is no score.
export const getRansomware = async (accountId) => {
  const { data } = await cloudAxios.get(`/security-center/${accountId}/ransomware`);
  return data;
};

export const getAttackPath = async (accountId, pathId, { maxDepth } = {}) => {
  const { data } = await cloudAxios.get(
    `/security-center/${accountId}/attack-paths/${pathId}${toQuery({ max_depth: maxDepth })}`,
  );
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
