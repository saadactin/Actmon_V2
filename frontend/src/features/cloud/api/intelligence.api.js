import { cloudAxios } from './axios';

/**
 * Resource Intelligence API client.
 *
 * Same wire dialect as the Security Center's: every list filter is sent
 * comma-joined (`severity=CRITICAL,HIGH`), because the backend reads each as
 * one comma-separated string. `toQuery` is the single place that happens.
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

export const getMeta = async () => {
  const { data } = await cloudAxios.get('/intelligence/meta');
  return data;
};

export const getSummary = async (accountId) => {
  const { data } = await cloudAxios.get(`/intelligence/${accountId}/summary`);
  return data;
};

export const getFindings = async (accountId, filters = {}) => {
  const { data } = await cloudAxios.get(`/intelligence/${accountId}/findings${toQuery(filters)}`);
  return data;
};

export const getFinding = async (accountId, source, key) => {
  const { data } = await cloudAxios.get(
    `/intelligence/${accountId}/findings/${source}/${encodeURIComponent(key)}`,
  );
  return data;
};

export const setFindingStatus = async (accountId, source, key, { status, reason }) => {
  const { data } = await cloudAxios.post(
    `/intelligence/${accountId}/findings/${source}/${encodeURIComponent(key)}/status`,
    { status, reason },
  );
  return data;
};

/**
 * The Intelligence tab's own refresh: collects 30 days of telemetry from the
 * provider's monitoring API and re-analyses. Synchronous — the caption after it
 * reports what the run found. 409 while a refresh or scan is running.
 */
export const runAnalysis = async (accountId) => {
  const { data } = await cloudAxios.post(`/intelligence/${accountId}/analyze`, null, {
    timeout: 15 * 60 * 1000,
  });
  return data;
};

export const getResourceHealth = async (accountId, resourceId) => {
  const { data } = await cloudAxios.get(`/intelligence/${accountId}/resources/${resourceId}/health`);
  return data;
};

export const getResourceTelemetry = async (accountId, resourceId) => {
  const { data } = await cloudAxios.get(`/intelligence/${accountId}/resources/${resourceId}/telemetry`);
  return data;
};

export const getCoverage = async (accountId) => {
  const { data } = await cloudAxios.get(`/intelligence/${accountId}/coverage`);
  return data;
};

export const getRuns = async (accountId, limit = 20) => {
  const { data } = await cloudAxios.get(`/intelligence/${accountId}/runs${toQuery({ limit })}`);
  return data;
};
