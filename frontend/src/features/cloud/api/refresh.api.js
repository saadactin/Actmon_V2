import { cloudAxios } from './axios';

/**
 * Account refresh.
 *
 * "Refresh" here means the backend re-reads the cloud account — inventory,
 * drift, cost, security, events — not that the browser reloads. Nothing in
 * this file calls `window.location.reload()`, and nothing should: a page
 * reload re-renders stale data, which is the opposite of the point.
 *
 * Every path carries the account id, and the server resolves the account
 * before anything else, so a refresh belonging to another account is a 404
 * rather than someone else's data.
 */

const base = (accountId) => `/accounts/${accountId}`;

/** Start a refresh. Returns as soon as the job is QUEUED — a full sweep takes
 *  minutes, so the request does not wait for it. Poll `getRefresh` for
 *  progress.
 *
 *  A 409 means one is already running; the error body carries that refresh so
 *  the caller can show its progress instead of an error. */
export const startRefresh = async (accountId, { test = false } = {}) => {
  const { data } = await cloudAxios.post(`${base(accountId)}/refresh`, null, {
    params: test ? { test: true } : {},
  });
  return data;
};

/** Current refresh, last attempt and last success — three separate things.
 *  A failed run must never overwrite the timestamp people read as "when was
 *  this account last actually refreshed". */
export const getLatestRefresh = async (accountId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/refresh/latest`);
  return data;
};

export const getRefresh = async (accountId, refreshId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/refresh/${refreshId}`);
  return data;
};

export const cancelRefresh = async (accountId, refreshId) => {
  const { data } = await cloudAxios.post(
    `${base(accountId)}/refresh/${refreshId}/cancel`,
  );
  return data;
};

export const getRefreshHistory = async (accountId, { limit = 20, status } = {}) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/refresh-history`, {
    params: { limit, ...(status ? { status } : {}) },
  });
  return data;
};

/** The schedule, plus the cadences the backend can honestly run. The options
 *  come from the server so the form cannot offer something the scheduler does
 *  not support. */
export const getRefreshSchedule = async (accountId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/refresh-schedule`);
  return data;
};

export const updateRefreshSchedule = async (accountId, payload) => {
  const { data } = await cloudAxios.put(
    `${base(accountId)}/refresh-schedule`, payload,
  );
  return data;
};

export const getRefreshCapabilities = async (accountId) => {
  const { data } = await cloudAxios.get(`${base(accountId)}/refresh-capabilities`);
  return data;
};
