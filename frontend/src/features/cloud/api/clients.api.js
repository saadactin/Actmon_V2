import { cloudAxios } from './axios';

/**
 * Clients, the portfolio, organisation onboarding and client reports.
 *
 * One module so the wire format is defined once. Organisation credentials are
 * sent in a POST body only — never in a query string, where they would land in
 * proxy and server logs.
 */

// ── Clients ─────────────────────────────────────────────────────────────────
export const getPortfolio = async () => {
  const { data } = await cloudAxios.get('/clients/portfolio');
  return data;
};

export const getClientOptions = async () => {
  const { data } = await cloudAxios.get('/clients/options');
  return data.clients || [];
};

export const getClient = async (clientId) => {
  const { data } = await cloudAxios.get(`/clients/${clientId}`);
  return data;
};

export const getClientScorecard = async (clientId) => {
  const { data } = await cloudAxios.get(`/clients/${clientId}/scorecard`);
  return data;
};

export const createClient = async (payload) => {
  const { data } = await cloudAxios.post('/clients', payload);
  return data;
};

export const updateClient = async (clientId, payload) => {
  const { data } = await cloudAxios.patch(`/clients/${clientId}`, payload);
  return data;
};

export const deleteClient = async (clientId) => {
  const { data } = await cloudAxios.delete(`/clients/${clientId}`);
  return data;
};

export const assignAccounts = async (clientId, accountIds) => {
  const { data } = await cloudAxios.put(`/clients/${clientId}/accounts`, {
    account_ids: accountIds,
  });
  return data;
};

export const unassignAccount = async (clientId, accountId) => {
  const { data } = await cloudAxios.delete(`/clients/${clientId}/accounts/${accountId}`);
  return data;
};

// ── Organisation onboarding ─────────────────────────────────────────────────
// Probing every member of a large organisation can take a while.
const ONBOARDING_TIMEOUT_MS = 180_000;

export const discoverOrganization = async (credentials) => {
  const { data } = await cloudAxios.post('/clients/onboarding/discover', credentials, {
    timeout: ONBOARDING_TIMEOUT_MS,
  });
  return data;
};

export const onboardOrganization = async (payload) => {
  const { data } = await cloudAxios.post('/clients/onboarding/onboard', payload, {
    timeout: ONBOARDING_TIMEOUT_MS,
  });
  return data;
};

// ── Reports ─────────────────────────────────────────────────────────────────
export const getReportSchedule = async (clientId) => {
  const { data } = await cloudAxios.get(`/clients/${clientId}/report-schedule`);
  return data;
};

export const saveReportSchedule = async (clientId, schedule) => {
  const { data } = await cloudAxios.put(`/clients/${clientId}/report-schedule`, schedule);
  return data;
};

export const listReports = async (clientId) => {
  const { data } = await cloudAxios.get(`/clients/${clientId}/reports`, { params: { limit: 24 } });
  return data.reports || [];
};

export const previewReport = async (clientId, period) => {
  const { data } = await cloudAxios.get(`/clients/${clientId}/report-preview`, {
    params: period ? { period } : {},
  });
  return data;
};

export const generateReport = async (clientId, { period, send = false } = {}) => {
  const { data } = await cloudAxios.post(`/clients/${clientId}/reports`,
    { period: period || null, send }, { timeout: 120_000 });
  return data;
};

export const sendReport = async (clientId, reportId) => {
  const { data } = await cloudAxios.post(`/clients/${clientId}/reports/${reportId}/send`);
  return data;
};

/** Fetch the PDF and hand it to the browser as a download. The server names
 *  the file; the fallback only applies if the header is missing. */
export const downloadReportPdf = async (clientId, reportId, fallbackName = 'report.pdf') => {
  const response = await cloudAxios.get(`/clients/${clientId}/reports/${reportId}/pdf`, {
    responseType: 'blob',
  });
  const disposition = response.headers?.['content-disposition'] || '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const name = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(response.data);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return name;
};
